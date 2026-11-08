import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";

/** d.ts of the Code block environment: Monaco offers hints from it for `inputs`/`params`/`log`/`fetch`. */
export const CODE_ENV_TYPES = `
/** Data on the input ports: { in0: ..., in1: ... } */
declare const inputs: Record<string, any>;
/** Node parameters (except the code itself). */
declare const params: Record<string, any>;
/** An entry in the run log. */
declare function log(...args: any[]): void;
/** Network. A subset of fetch is supported: text() / json() / ok / status / headers.get(). */
declare function fetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}>;
`;

const DEFAULT_CODE = `// Function body. Available: inputs, params, log, fetch.
// Return an object { out0: <json> }: the keys are output port ids.
return { out0: inputs.in0 ?? null }
`;

/**
 * Bootstrap runs INSIDE the vm context. Only strings cross the context boundary:
 * otherwise host-realm objects (`fetch.constructor.constructor("return process")()`) would give a way out.
 * So data is parsed here, and fetch is a wrapper over the string bridge `host.fetch`.
 */
const makeBootstrap = (extra: string) => `(() => {
  const host = __host;
  delete globalThis.__host;
  // the context's built-in console is not part of env; the user is given log
  delete globalThis.console;

  globalThis.inputs = JSON.parse(host.inputs);
  globalThis.params = JSON.parse(host.params);

  const fmt = (x) => {
    if (typeof x === "string") return x;
    try { return JSON.stringify(x); } catch { return String(x); }
  };
  globalThis.log = (...args) => { host.log(args.map(fmt).join(" ")); };

  globalThis.fetch = async (url, init) => {
    const i = init || {};
    const headers = {};
    if (i.headers) for (const k of Object.keys(i.headers)) headers[k] = String(i.headers[k]);
    const out = JSON.parse(await host.fetch(JSON.stringify({
      url: String(url),
      method: i.method == null ? undefined : String(i.method),
      headers,
      body: i.body == null ? undefined : String(i.body),
    })));
    if (out.error !== undefined) throw new TypeError(out.error);
    const lower = {};
    for (const k of Object.keys(out.headers)) lower[k.toLowerCase()] = out.headers[k];
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      statusText: out.statusText,
      url: out.url,
      headers: { get: (n) => (lower[String(n).toLowerCase()] ?? null) },
      text: async () => out.body,
      json: async () => JSON.parse(out.body),
    };
  };

  ${extra}

  return (r) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new TypeError("Code must return an object like { out0: <json> }");
    }
    return JSON.stringify(r);
  };
})()`;

const errorMessage = (e: unknown): string =>
  // errors from the vm context belong to another realm, instanceof Error is false for them
  e !== null && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

/**
 * The only block that executes code from a flow (architecture rule 5): `node:vm`, the environment is only
 * what is explicitly put into the context, with a timeout and cancellation via `ctx.signal`.
 *
 * `vm` limitations: a synchronous loop is interrupted by the timeout; a loop AFTER `await` is not
 * (the continuation runs outside `timeout`), it is stopped by cancellation/kill of the runner process.
 */
export class CodeBlock extends Block {
  static type = "code";
  static label = "Code";
  static icon = "code";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "code", type: "string", required: true, default: DEFAULT_CODE, editor: "code", expressions: false },
    { name: "timeoutMs", type: "number", default: 10000, min: 1, max: 300_000 },
  ];
  static codeTypes = CODE_ENV_TYPES;

  /**
   * Extension of the code environment for subclasses (Code Agent): string functions of the `host` bridge and init code inside
   * the vm context (it has access to `host` declared above). Only strings cross the context boundary.
   */
  protected bridge(_ctx: RunContext): { host: Record<string, unknown>; bootstrap: string } {
    return { host: {}, bootstrap: "" };
  }

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    // node-only API: only inside the body of run
    const vm = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:vm");

    const code = String(params["code"] ?? "");
    const timeoutMs = Number(params["timeoutMs"] ?? 10000);
    const { code: _code, ...userParams } = params;

    // the code's network requests are aborted together with the block's timeout/cancellation
    const net = new AbortController();
    const hostFetch = async (reqJson: string): Promise<string> => {
      // does not throw or reject: a host error inside the context would also give a way out via constructor
      try {
        const req = JSON.parse(reqJson) as {
          url: string;
          method?: string;
          headers: Record<string, string>;
          body?: string;
        };
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: net.signal,
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return JSON.stringify({
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          headers,
          body: await res.text(),
        });
      } catch (e) {
        return JSON.stringify({ error: errorMessage(e) });
      }
    };

    // env: the only thing the code sees. require / fs / process do NOT get here.
    const extra = this.bridge(ctx);
    const host = {
      inputs: JSON.stringify(inputs),
      params: JSON.stringify(userParams),
      log: (msg: string) => ctx.log(msg),
      fetch: hostFetch,
      ...extra.host,
    };

    // The sandbox prototype must be null: otherwise `globalThis.constructor` is the HOST's Object,
    // and `globalThis.constructor.constructor("return process")()` yields process (the classic escape).
    const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, { __host: host });
    const context = vm.createContext(sandbox);
    const serialize = vm.runInContext(makeBootstrap(extra.bootstrap), context, { filename: "code-bootstrap.js" }) as (r: unknown) => string;
    // the user's body starts on the first line, so line numbers in errors match the editor
    const script = new vm.Script(`(async function () {${code}\n})()`, { filename: "code-block.js" });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const json = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Code timed out after ${timeoutMs} ms`)), timeoutMs);
        onAbort = () => reject(new Error("Aborted"));
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) return onAbort();

        let running: Promise<unknown>;
        try {
          // timeout here bounds the synchronous part of the code (an infinite while and the like)
          running = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
        } catch (e) {
          reject(new Error(errorMessage(e)));
          return;
        }
        // serialize can throw too (the result is not an object, a cycle): that is a block failure, not an unhandled rejection
        running
          .then((r) => serialize(r))
          .then(resolve, (e) => reject(new Error(errorMessage(e), { cause: e })));
      });
      return JSON.parse(json) as Record<string, Json>;
    } catch (e) {
      throw new Error(errorMessage(e), { cause: e });
    } finally {
      clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
      net.abort();
    }
  }
}

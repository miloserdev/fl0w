import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";

/** d.ts окружения Code-блока: Monaco подсказывает по нему `inputs`/`params`/`log`/`fetch`. */
export const CODE_ENV_TYPES = `
/** Данные на входных портах: { in0: ..., in1: ... } */
declare const inputs: Record<string, any>;
/** Параметры ноды (кроме самого кода). */
declare const params: Record<string, any>;
/** Запись в лог запуска. */
declare function log(...args: any[]): void;
/** Сеть. Поддерживается подмножество fetch: text() / json() / ok / status / headers.get(). */
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

const DEFAULT_CODE = `// Тело функции. Доступны: inputs, params, log, fetch.
// Верните объект { out0: <json> } — ключи это id выходных портов.
return { out0: inputs.in0 ?? null }
`;

/**
 * Bootstrap выполняется ВНУТРИ vm-контекста. Через границу контекста ходят только строки:
 * иначе объекты хост-реалма (`fetch.constructor.constructor("return process")()`) дали бы выход наружу.
 * Поэтому данные парсятся здесь, а fetch — обёртка над строковым мостом `host.fetch`.
 */
const BOOTSTRAP = `(() => {
  const host = __host;
  delete globalThis.__host;
  // встроенный console контекста — не часть env; пользователю дан log
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

  return (r) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new TypeError("Code must return an object like { out0: <json> }");
    }
    return JSON.stringify(r);
  };
})()`;

const errorMessage = (e: unknown): string =>
  // ошибки из vm-контекста — другой реалм, instanceof Error для них false
  e !== null && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

/**
 * Единственный блок, исполняющий код из флоу (SPEC §5a, §12): `node:vm`, окружение — только
 * явно положенное в контекст, таймаут и отмена по `ctx.signal`.
 *
 * Ограничения `vm`: синхронный цикл обрывается по таймауту; цикл ПОСЛЕ `await` — нет
 * (продолжение идёт вне `timeout`), его останавливает отмена/kill процесса-раннера.
 */
export class CodeBlock extends Block {
  static type = "code";
  static label = "Code";
  static icon = "code";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "code", type: "string", required: true, default: DEFAULT_CODE, editor: "code" },
    { name: "timeoutMs", type: "number", default: 10000 },
  ];
  static codeTypes = CODE_ENV_TYPES;

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    // node-only API — только внутри тела run (SPEC §3, изоморфность модуля)
    const vm = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:vm");

    const code = String(params["code"] ?? "");
    const timeoutMs = Number(params["timeoutMs"] ?? 10000);
    const { code: _code, ...userParams } = params;

    // сетевые запросы кода гасятся вместе с таймаутом/отменой блока
    const net = new AbortController();
    const hostFetch = async (reqJson: string): Promise<string> => {
      // не бросает и не отклоняется: хост-ошибка внутри контекста тоже дала бы выход через constructor
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

    // env: единственное, что видит код. require / fs / process сюда НЕ попадают.
    const host = {
      inputs: JSON.stringify(inputs),
      params: JSON.stringify(userParams),
      log: (msg: string) => ctx.log(msg),
      fetch: hostFetch,
    };

    // Прототип sandbox обязан быть null: иначе `globalThis.constructor` — это Object ХОСТА,
    // и `globalThis.constructor.constructor("return process")()` выдаёт process (классический escape).
    const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, { __host: host });
    const context = vm.createContext(sandbox);
    const serialize = vm.runInContext(BOOTSTRAP, context, { filename: "code-bootstrap.js" }) as (r: unknown) => string;
    // тело пользователя начинается на первой строке — номера строк в ошибках совпадают с редактором
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
          // timeout здесь ограничивает синхронную часть кода (бесконечный while и т.п.)
          running = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
        } catch (e) {
          reject(new Error(errorMessage(e)));
          return;
        }
        // serialize тоже может бросить (результат — не объект, цикл) — это отказ блока, а не unhandled rejection
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

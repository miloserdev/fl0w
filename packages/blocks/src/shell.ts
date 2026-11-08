import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { resolveTemplates } from "./json-path";
import { filesBaseDir, resolveInside } from "./sandbox";
import { textOf } from "./value-io";

export const SHELL_ALLOW_ENV = "FL0W_ALLOW_SHELL";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The command's environment is only this (+ what is set in `env`): the server process's secrets do not get into it. */
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM"];

export const isShellEnabled = (): boolean => ["1", "true", "yes"].includes(String(process.env[SHELL_ALLOW_ENV] ?? "").toLowerCase());

/**
 * Shell (Bash): runs a script with the command shell ON THIS MACHINE.
 * This is an exception to the rule that user code runs only in the Code block (architecture rule 5 in CLAUDE.md) and is DISABLED by default: it is enabled only by the `FL0W_ALLOW_SHELL=1` variable
 * on the server, because the editor and API are available without authorisation, and anyone who reached the port
 * would get command execution.
 *
 * The script is NOT templated. Data is passed separately and safely: `args` are positional parameters
 * `$1`, `$2`... (never pasted into the script text), `env` are environment variables, `stdin` is the input.
 * It runs in the files directory (`cwd` is a subfolder), with a timeout; cancellation and timeout kill the whole process group.
 */
export class Shell extends Block {
  static type = "shell";
  static label = "Shell";
  static icon = "terminal";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "script", type: "string", multiline: true, required: true, default: 'echo "hello"', expressions: false },
    // positional parameters $1, $2...; strings support "{{ path }}" from the input
    { name: "args", type: "json", default: [] },
    // environment variables { NAME: value } (values support templates)
    { name: "env", type: "json", default: {} },
    { name: "stdin", type: "string", default: "" },
    // subfolder of the files directory; empty means the directory itself
    { name: "cwd", type: "string", default: "" },
    {
      name: "shell",
      type: "enum",
      default: "bash",
      options: [{ value: "bash" }, { value: "sh" }],
    },
    { name: "timeoutMs", type: "number", default: 30_000, min: 100, max: 300_000 },
    // a non-zero exit code is a node error
    { name: "failOnError", type: "boolean", default: true },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    if (!isShellEnabled()) {
      throw new Error(`Shell execution is disabled. Start the server with ${SHELL_ALLOW_ENV}=1 to allow commands on this machine`);
    }
    const input = inputs["in0"] ?? null;
    const cp = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:child_process");

    const script = String(params["script"] ?? "");
    if (script.trim() === "") throw new Error('Shell: "script" is empty');
    const shell = String(params["shell"] ?? "bash");
    if (shell !== "bash" && shell !== "sh") throw new Error(`Unknown shell "${shell}"`);
    const timeoutMs = Number(params["timeoutMs"] ?? 30_000);

    const rawArgs = params["args"] ?? [];
    if (!Array.isArray(rawArgs)) throw new Error('Shell: "args" must be a list');
    const args = rawArgs.map((a) => textOf(resolveTemplates(a, input)));

    const rawEnv = params["env"] ?? {};
    if (rawEnv === null || typeof rawEnv !== "object" || Array.isArray(rawEnv)) throw new Error('Shell: "env" must be an object');
    const env: Record<string, string> = {};
    for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!ENV_NAME.test(k)) throw new Error(`Shell: invalid environment variable name "${k}"`);
      env[k] = textOf(resolveTemplates(v, input));
    }
    const stdin = typeof params["stdin"] === "string" && params["stdin"] !== "" ? textOf(resolveTemplates(params["stdin"], input)) : null;

    const base = await filesBaseDir();
    const cwd = await resolveInside(base, String(params["cwd"] ?? ""));

    // "$0" = the shell name, then positional parameters: data never gets into the script text
    const child = cp.spawn(shell, ["-c", script, shell, ...args], {
      cwd,
      // Next extends ProcessEnv with a mandatory NODE_ENV; our environment is deliberately minimal
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const collect = (kind: "out" | "err") => (chunk: Buffer) => {
      const cur = kind === "out" ? stdout : stderr;
      if (cur.length >= MAX_OUTPUT_BYTES) return void (truncated = true);
      const next = cur + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT_BYTES) truncated = true;
      if (kind === "out") stdout = next.slice(0, MAX_OUTPUT_BYTES);
      else stderr = next.slice(0, MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    child.stdin.on("error", () => {}); // the command may have finished without reading the input
    child.stdin.end(stdin ?? "");

    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already finished
      }
    };

    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        killGroup();
        done(() => reject(new Error(`Shell timed out after ${timeoutMs} ms`)));
      }, timeoutMs);
      const onAbort = () => {
        killGroup();
        done(() => reject(new Error("Aborted")));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) return onAbort();
      child.on("error", (e) => done(() => reject(new Error(`Shell failed to start: ${e.message}`, { cause: e }))));
      // 'close' fires after the process ends and the streams close: the output has already been fully collected
      child.on("close", (c, s) => done(() => resolve({ code: c, signal: s })));
    });

    if (code !== 0 && params["failOnError"] !== false) {
      const tail = (stderr.trim() || stdout.trim()).slice(-500);
      throw new Error(`Command failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${tail ? `: ${tail}` : ""}`);
    }
    return { out0: { stdout, stderr, exitCode: code, signal, ...(truncated ? { truncated: true } : {}) } };
  }
}

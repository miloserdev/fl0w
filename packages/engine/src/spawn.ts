/**
 * Parent side of the process runner. Node-only: imported ONLY on the server
 * (`@fl0w/engine/process`); the main `@fl0w/engine` entry stays isomorphic.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callResolveRequestSchema, runnerEventSchema, type CallResolveReply, type Flow, type Json, type RunnerCommand, type RunnerControl, type RunnerEvent } from "@fl0w/schema";
import type { SchedulerRun } from "./scheduler";

export type ProcessRunOptions = {
  /** Directory of the engine package (the process cwd, where tsx is resolved from). Defaults to next to this file. */
  engineDir?: string;
  /** Runner script. Defaults to `<engineDir>/src/runner.ts`. */
  runnerPath?: string;
  /** Node flags for the process. Defaults to `--import tsx`, running TS sources without a build. */
  execArgv?: string[];
  /**
   * Time limit for the whole run: when it expires the process is killed. A safety net for code that
   * `vm` cannot interrupt on its own (an infinite loop after `await`). No limit by default.
   */
  timeoutMs?: number;
  /** Trigger node the run starts from (a scheduled run); without it all triggers fire. */
  trigger?: string;
  /** Trigger firing data (webhook body, etc.). */
  triggerData?: Json;
  /** Restart from a node, with data from the previous run for its predecessors (see RunOptions.from). */
  from?: string;
  seeds?: Record<string, Record<string, Json>>;
  /** Pins apply even when `trigger` is set (the sandbox runs a single trigger with a button on the node). */
  pins?: boolean;
  /**
   * Find a flow with an incoming call on a channel (at the request of an outgoing call block): the runner executes it as a nested run in its own
   * process, so it needs the definition itself. A refusal is an exception (the block sees its text). Without it, outgoing call fails with a clear error.
   */
  onResolveCall?: (channelId: string) => Promise<{ flow: Flow; triggerId: string }>;
  /** Trial run from the editor (sandbox): a separate memory directory. Scheduled runs of published flows have no flag. */
  sandbox?: boolean;
  /** Cancel: kills the process and finishes the run with a `flow:done` event carrying an error. */
  signal?: AbortSignal;
  /** Receives control of the running run: pause/resume (after the process starts; a no-op after it finishes). */
  onControl?: (control: { pause: () => void; resume: () => void }) => void;
  /** The process's stderr (block logs, crashes). */
  onStderr?: (chunk: string) => void;
};

type FlowDone = Extract<RunnerEvent, { event: "flow:done" }>;

const STDERR_TAIL = 2000;
const KILL_GRACE_MS = 1000;

/**
 * Runs a flow in a separate Node.js process and streams events to `onEvent`.
 * Guarantees: exactly one `flow:done` at the end; the promise never rejects; the process does not outlive the run.
 */
export function runFlowInProcess(
  flow: Flow,
  onEvent: (e: RunnerEvent) => void,
  opts: ProcessRunOptions = {},
): Promise<void> {
  const engineDir =
    opts.engineDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runnerPath =
    opts.runnerPath ?? path.join(/* turbopackIgnore: true */ engineDir, "src", "runner.ts");

  return new Promise<void>((resolve) => {
    let child: ChildProcess | undefined;
    let finished = false;
    let stderrTail = "";

    let deadline: ReturnType<typeof setTimeout> | undefined;

    const finish = (e: Omit<FlowDone, "event">) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      onEvent({ event: "flow:done", ...e });
      resolve();
      // the process should exit by itself; if it hangs, finish it off
      const proc = child;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }
    };

    const onAbort = () => {
      child?.kill("SIGKILL");
      finish({ error: "Aborted" });
    };

    if (opts.signal?.aborted) {
      finish({ error: "Aborted" });
      return;
    }

    try {
      child = fork(/* turbopackIgnore: true */ runnerPath, [], {
        cwd: engineDir,
        execArgv: opts.execArgv ?? ["--import", "tsx"],
        // sandbox ("Run"): memory banks are separate from those of working (published) flows, so trial runs do not corrupt their data
        env: opts.sandbox ? sandboxEnv() : process.env,
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch (e) {
      finish({ error: `Failed to start runner: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        child?.kill("SIGKILL");
        finish({ error: `Run timed out after ${opts.timeoutMs} ms` });
      }, opts.timeoutMs);
    }

    const proc = child;
    const sendControl = (cmd: RunnerControl["cmd"]) => () => {
      if (!finished && proc.connected) proc.send({ cmd } satisfies RunnerControl);
    };
    opts.onControl?.({ pause: sendControl("pause"), resume: sendControl("resume") });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      opts.onStderr?.(chunk);
    });

    proc.on("message", (raw) => {
      if (finished) return;
      const resolveReq = callResolveRequestSchema.safeParse(raw);
      if (resolveReq.success) {
        const { id, channelId } = resolveReq.data;
        const reply = (r: Omit<CallResolveReply, "cmd" | "id">) => {
          if (!finished && proc.connected) proc.send({ cmd: "call:resolved", id, ...r } satisfies CallResolveReply);
        };
        if (!opts.onResolveCall) reply({ error: "Calling other flows is not available here" });
        else {
          void Promise.resolve()
            .then(() => opts.onResolveCall!(channelId))
            .then((t) => reply({ flow: t.flow, triggerId: t.triggerId }), (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }
      const parsed = runnerEventSchema.safeParse(raw);
      if (!parsed.success) {
        child?.kill("SIGKILL");
        finish({ error: "Runner protocol error: malformed event" });
        return;
      }
      if (parsed.data.event === "flow:done") {
        const { event: _event, ...rest } = parsed.data;
        finish(rest);
      } else {
        onEvent(parsed.data);
      }
    });

    proc.on("error", (e) => finish({ error: `Runner process error: ${e.message}` }));

    // 'close' arrives after the process has exited and all streams/IPC have been drained
    proc.on("close", (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const tail = stderrTail.trim();
      finish({ error: `Runner exited unexpectedly (${how})${tail ? `: ${tail}` : ""}` });
    });

    proc.send({ cmd: "run", flow, trigger: opts.trigger, triggerData: opts.triggerData, from: opts.from, seeds: opts.seeds, pins: opts.pins } satisfies RunnerCommand, (err) => {
      if (err) finish({ error: `Failed to send command to runner: ${err.message}` });
    });
  });
}

/**
 * Executor for the scheduler: every run is a separate runner process.
 * Passes the trigger AND its data in full, so the scheduler and the runner cannot diverge on the set of fields.
 */
/** Sandbox runner environment: the same, but the memory banks directory is the nested `_sandbox` folder. */
export function sandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = base["FL0W_MEMORY_DIR"];
  return dir ? { ...base, FL0W_MEMORY_DIR: `${dir.replace(/[\\/]+$/, "")}/_sandbox` } : base;
}

export function processSchedulerRun(base: Pick<ProcessRunOptions, "engineDir" | "timeoutMs" | "execArgv"> = {}): SchedulerRun {
  return (flow, onEvent, { trigger, triggerData, onResolveCall }) => runFlowInProcess(flow, onEvent, { ...base, trigger, triggerData, onResolveCall });
}

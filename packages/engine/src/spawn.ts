/**
 * Родительская сторона process-runner. Node-only: импортируется ТОЛЬКО на сервере
 * (`@fl0w/engine/process`), основной вход `@fl0w/engine` остаётся изоморфным.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callResolveRequestSchema, runnerEventSchema, type CallResolveReply, type Flow, type Json, type RunnerCommand, type RunnerEvent } from "@fl0w/schema";
import type { SchedulerRun } from "./scheduler";

export type ProcessRunOptions = {
  /** Каталог пакета engine (cwd процесса, откуда резолвится tsx). По умолчанию — рядом с этим файлом. */
  engineDir?: string;
  /** Скрипт раннера. По умолчанию `<engineDir>/src/runner.ts`. */
  runnerPath?: string;
  /** Флаги node для процесса. По умолчанию `--import tsx` — исполнение TS-исходников без сборки. */
  execArgv?: string[];
  /**
   * Предел времени всего запуска: по истечении процесс убивается. Страховка для кода, который
   * `vm` не прерывает сам (бесконечный цикл после `await`). По умолчанию без ограничения.
   */
  timeoutMs?: number;
  /** Триггер-нода, от которой стартует запуск (плановый запуск); без неё срабатывают все триггеры. */
  trigger?: string;
  /** Данные срабатывания триггера (тело вебхука и т.п.). */
  triggerData?: Json;
  /** Перезапуск с ноды и данные прошлого запуска для её предшественников (см. RunOptions.from). */
  from?: string;
  seeds?: Record<string, Record<string, Json>>;
  /**
   * Найти флоу с phone-incoming на канале (по просьбе блока phone-outgoing): раннер исполняет его вложенным запуском в своём
   * процессе, поэтому ему нужно само определение. Отказ — исключение (текст увидит блок). Без него phone-outgoing падает с понятной ошибкой.
   */
  onResolveCall?: (channelId: string) => Promise<{ flow: Flow; triggerId: string }>;
  /** Пробный запуск из редактора (песочница): отдельный каталог памяти. Плановые запуски опубликованных флоу — без флага. */
  sandbox?: boolean;
  /** Отмена: убивает процесс и завершает запуск событием `flow:done` с ошибкой. */
  signal?: AbortSignal;
  /** stderr процесса (лог блоков, падения). */
  onStderr?: (chunk: string) => void;
};

type FlowDone = Extract<RunnerEvent, { event: "flow:done" }>;

const STDERR_TAIL = 2000;
const KILL_GRACE_MS = 1000;

/**
 * Запускает флоу в отдельном Node.js-процессе и стримит события в `onEvent`.
 * Гарантии: ровно один `flow:done` в конце; промис не отклоняется; процесс не переживает запуск.
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
      // процесс должен выйти сам; если завис — добиваем
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
        // песочница («Запустить»): банки памяти отдельные от рабочих (опубликованных) флоу — пробные запуски не портят их данные
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

    // 'close' приходит после того, как процесс завершился и все потоки/IPC дочитаны
    proc.on("close", (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const tail = stderrTail.trim();
      finish({ error: `Runner exited unexpectedly (${how})${tail ? `: ${tail}` : ""}` });
    });

    proc.send({ cmd: "run", flow, trigger: opts.trigger, triggerData: opts.triggerData, from: opts.from, seeds: opts.seeds } satisfies RunnerCommand, (err) => {
      if (err) finish({ error: `Failed to send command to runner: ${err.message}` });
    });
  });
}

/**
 * Исполнитель для планировщика: каждый запуск — отдельный процесс-раннер (SPEC §2.1).
 * Передаёт триггер И его данные целиком — планировщик и раннер не должны расходиться в наборе полей.
 */
/** Окружение раннера песочницы: тот же, но каталог банков памяти — вложенная папка `_sandbox`. */
export function sandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = base["FL0W_MEMORY_DIR"];
  return dir ? { ...base, FL0W_MEMORY_DIR: `${dir.replace(/[\\/]+$/, "")}/_sandbox` } : base;
}

export function processSchedulerRun(base: Pick<ProcessRunOptions, "engineDir" | "timeoutMs" | "execArgv"> = {}): SchedulerRun {
  return (flow, onEvent, { trigger, triggerData, onResolveCall }) => runFlowInProcess(flow, onEvent, { ...base, trigger, triggerData, onResolveCall });
}

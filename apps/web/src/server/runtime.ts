import path from "node:path";
import { registry } from "@fl0w/blocks";
import { runFlowInProcess } from "@fl0w/engine/process";
import { FlowStore, RunHub, Scheduler } from "@fl0w/engine/server";
import { engineDir } from "./engine-dir";

/** Предел времени одного запуска; дальше процесс-раннер убивается. */
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;

class Runtime {
  readonly store: FlowStore;
  readonly hub = new RunHub();
  readonly scheduler: Scheduler;
  private started: Promise<void> | null = null;

  constructor() {
    // Каталог данных: переменная окружения или .data рядом с приложением (в .gitignore).
    const dir = process.env["FL0W_DATA_DIR"] ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "flows");
    this.store = new FlowStore(dir);
    this.scheduler = new Scheduler({
      store: this.store,
      hub: this.hub,
      registry,
      // каждый плановый запуск — отдельный процесс, как и ручной (SPEC §2.1)
      run: (flow, onEvent, { trigger }) =>
        runFlowInProcess(flow, onEvent, {
          engineDir: engineDir(),
          trigger,
          timeoutMs: RUN_TIMEOUT_MS,
        }),
      log: (msg) => console.log(`[scheduler] ${msg}`),
    });
  }

  /** Поднимает расписание опубликованных флоу; идемпотентно, вызывается и при старте сервера, и из роутов. */
  start(): Promise<void> {
    this.started ??= this.scheduler.start().catch((e) => {
      console.error("[scheduler] failed to start:", e);
    });
    return this.started;
  }
}

// Один экземпляр на процесс: переживает пересборку модулей при HMR в dev, иначе таймеры задвоятся.
const g = globalThis as { __fl0wRuntime?: Runtime };

export function getRuntime(): Runtime {
  return (g.__fl0wRuntime ??= new Runtime());
}

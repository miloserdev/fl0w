import path from "node:path";
import { registry } from "@fl0w/blocks";
import { processSchedulerRun } from "@fl0w/engine/process";
import { createFileWatcher, createMailPoller, createTelegramSources, FlowStore, RunHub, Scheduler } from "@fl0w/engine/server";
import { engineDir } from "./engine-dir";

/** Предел времени одного запуска; дальше процесс-раннер убивается. */
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;

class Runtime {
  readonly store: FlowStore;
  readonly hub = new RunHub();
  readonly scheduler: Scheduler;
  /** Источники Telegram Trigger; `handleWebhook` принимает входящие обновления вебхука. */
  readonly telegram = createTelegramSources({ log: (msg) => console.log(`[telegram] ${msg}`) });
  private started: Promise<void> | null = null;

  constructor() {
    // Каталог данных: переменная окружения или .data рядом с приложением (в .gitignore).
    const dir = process.env["FL0W_DATA_DIR"] ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "flows");
    this.store = new FlowStore(dir);
    // Каталог файлов для блоков Read/Write Files, Shell и Local File Trigger (выше него доступа нет).
    // Переменная выставляется в окружение сервера, поэтому её наследуют процессы-раннеры.
    const filesDir = process.env["FL0W_FILES_DIR"] ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "files");
    process.env["FL0W_FILES_DIR"] = filesDir;
    // Каталог банков памяти (блок Memory Bank, драйвер json): рядом с данными флоу, наследуется процессами-раннерами.
    process.env["FL0W_MEMORY_DIR"] ??= path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "memory");
    this.scheduler = new Scheduler({
      store: this.store,
      hub: this.hub,
      registry,
      // каждый плановый запуск — отдельный процесс, как и ручной (SPEC §2.1)
      run: processSchedulerRun({ engineDir: engineDir(), timeoutMs: RUN_TIMEOUT_MS }),
      watchFiles: createFileWatcher({ baseDir: filesDir, log: (msg) => console.log(`[file-watch] ${msg}`) }),
      // Telegram Trigger: опрос (по умолчанию, только исходящие запросы) или вебхук (нужен FL0W_PUBLIC_URL)
      pollTelegram: this.telegram.factory,
      // Mail Trigger: опрос почтового ящика (IMAP или Microsoft Graph)
      pollMail: createMailPoller({ log: (msg) => console.log(`[mail] ${msg}`) }),
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
  const current = g.__fl0wRuntime;
  // В dev после правки движка модуль пересобран, а в globalThis остался экземпляр СТАРОГО класса (без новых методов планировщика —
  // «scheduler.fireFrom is not a function»). Такой экземпляр останавливаем и создаём заново из актуального кода.
  if (current && current.constructor !== Runtime) {
    current.scheduler.stop();
    g.__fl0wRuntime = undefined;
  }
  return (g.__fl0wRuntime ??= new Runtime());
}

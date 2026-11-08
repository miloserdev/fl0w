import path from "node:path";
import { registry } from "@fl0w/blocks";
import { processSchedulerRun } from "@fl0w/engine/process";
import { createFileWatcher, createMailPoller, createTelegramSources, FlowStore, RunHub, Scheduler } from "@fl0w/engine/server";
import { engineDir } from "./engine-dir";

/** Time limit of a single run; after it the runner process is killed. */
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;

class Runtime {
  readonly store: FlowStore;
  readonly hub = new RunHub();
  readonly scheduler: Scheduler;
  /** Telegram Trigger sources; `handleWebhook` accepts incoming webhook updates. */
  readonly telegram = createTelegramSources({ log: (msg) => console.log(`[telegram] ${msg}`) });
  private started: Promise<void> | null = null;

  constructor() {
    // Data directory: an environment variable or .data next to the application (in .gitignore).
    const dir = process.env["FL0W_DATA_DIR"] ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "flows");
    this.store = new FlowStore(dir);
    // Files directory for the Read/Write Files, Shell and Local File Trigger blocks (there is no access above it).
    // The variable is set in the server environment, so runner processes inherit it.
    const filesDir = process.env["FL0W_FILES_DIR"] ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "files");
    process.env["FL0W_FILES_DIR"] = filesDir;
    // Memory banks directory (Memory Bank block, json driver): next to the flow data, inherited by the runner processes.
    process.env["FL0W_MEMORY_DIR"] ??= path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "memory");
    this.scheduler = new Scheduler({
      store: this.store,
      hub: this.hub,
      registry,
      // each scheduled run is a separate process, like a manual one
      run: processSchedulerRun({ engineDir: engineDir(), timeoutMs: RUN_TIMEOUT_MS }),
      watchFiles: createFileWatcher({ baseDir: filesDir, log: (msg) => console.log(`[file-watch] ${msg}`) }),
      // Telegram Trigger: polling (default, outgoing requests only) or webhook (needs FL0W_PUBLIC_URL)
      pollTelegram: this.telegram.factory,
      // Mail Trigger: polling a mailbox (IMAP or Microsoft Graph)
      pollMail: createMailPoller({ log: (msg) => console.log(`[mail] ${msg}`) }),
      log: (msg) => console.log(`[scheduler] ${msg}`),
    });
  }

  /** Starts the schedule of published flows; idempotent, called both at server start and from routes. */
  start(): Promise<void> {
    this.started ??= this.scheduler.start().catch((e) => {
      console.error("[scheduler] failed to start:", e);
    });
    return this.started;
  }
}

// One instance per process: survives module rebuilds under HMR in dev, otherwise timers would double.
const g = globalThis as { __fl0wRuntime?: Runtime };

export function getRuntime(): Runtime {
  const current = g.__fl0wRuntime;
  // In dev after an engine edit the module is rebuilt, but globalThis still holds an instance of the OLD class (without the scheduler's new methods —
  // "scheduler.fireFrom is not a function"). Such an instance is stopped and recreated from the current code.
  if (current && current.constructor !== Runtime) {
    current.scheduler.stop();
    g.__fl0wRuntime = undefined;
  }
  return (g.__fl0wRuntime ??= new Runtime());
}

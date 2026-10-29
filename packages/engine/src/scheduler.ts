import type { Flow, RunnerEvent } from "@fl0w/schema";
import type { RunHub } from "./hub";
import type { FlowStore } from "./store";
import { validateFlow, type Registry } from "./validate";

export type SchedulerRun = (
  flow: Flow,
  onEvent: (e: RunnerEvent) => void,
  opts: { trigger: string },
) => Promise<void>;

export type SchedulerDeps = {
  store: FlowStore;
  hub: RunHub;
  registry: Registry;
  /** Исполнитель запуска (в проде — отдельный процесс-раннер). */
  run: SchedulerRun;
  log?: (msg: string) => void;
};

/** setTimeout не умеет задержки > 2^31-1 мс (сработает сразу) — длинные периоды режем на куски. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Периодический вызов `fn` каждые `ms`; цепочка таймеров без накопления дрейфа от выполнения fn. */
function every(ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    let remaining = ms;
    const step = () => {
      const d = Math.min(remaining, MAX_TIMER_MS);
      remaining -= d;
      timer = setTimeout(() => {
        if (stopped) return;
        if (remaining > 0) return step();
        arm(); // сначала следующий тик — не зависит от длительности fn
        fn();
      }, d);
      timer.unref?.();
    };
    step();
  };
  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

type Job = { nodeId: string; stop: () => void };

/**
 * Планировщик: для каждого опубликованного флоу ставит таймеры по его триггер-нодам
 * (период даёт сам блок через `intervalMs`) и запускает флоу от сработавшего триггера.
 * Работает на сервере — независимо от того, открыт ли UI.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job[]>();
  private readonly busy = new Set<string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Поднимает расписание всех опубликованных флоу из хранилища (при старте сервера). */
  async start(): Promise<void> {
    const flows = await this.deps.store.list((file, e) =>
      this.log(`skipping unreadable flow file ${file}: ${e instanceof Error ? e.message : String(e)}`),
    );
    for (const flow of flows) this.sync(flow);
  }

  /** Приводит расписание флоу в соответствие с его состоянием: published — ставит таймеры, иначе снимает. */
  sync(flow: Flow): void {
    this.clear(flow.id);
    if (flow.status !== "published") return;

    const checked = validateFlow(flow, this.deps.registry);
    if (!checked.ok) {
      this.log(`flow ${flow.id} is published but invalid, not scheduled: ${checked.issues[0]?.message}`);
      return;
    }

    const jobs: Job[] = [];
    for (const node of flow.nodes) {
      const cls = this.deps.registry[node.type];
      if (!cls?.isTrigger) continue;
      const ms = cls.intervalMs(node.params);
      if (ms === null) continue;
      jobs.push({ nodeId: node.id, stop: every(ms, () => void this.fire(flow, node.id)) });
      this.log(`flow ${flow.id}: trigger ${node.id} every ${ms} ms`);
    }
    if (jobs.length > 0) this.jobs.set(flow.id, jobs);
  }

  isScheduled(flowId: string): boolean {
    return this.jobs.has(flowId);
  }

  stop(): void {
    for (const id of [...this.jobs.keys()]) this.clear(id);
  }

  private clear(flowId: string) {
    for (const j of this.jobs.get(flowId) ?? []) j.stop();
    this.jobs.delete(flowId);
  }

  private async fire(flow: Flow, nodeId: string): Promise<void> {
    // один запуск флоу за раз: если прошлый ещё идёт — тик пропускаем, а не копим очередь
    if (this.busy.has(flow.id)) {
      this.deps.hub.skip(flow.id, nodeId, "busy");
      this.log(`flow ${flow.id}: tick of ${nodeId} skipped, previous run is still active`);
      return;
    }
    this.busy.add(flow.id);
    const { hub } = this.deps;
    const runId = hub.startRun(flow.id, nodeId);
    const started = Date.now();
    try {
      await this.deps.run(flow, (e) => hub.publish(flow.id, runId, e), { trigger: nodeId });
    } catch (e) {
      // run не должен бросать, но если бросил — запуск обязан закрыться событием
      hub.publish(flow.id, runId, {
        event: "flow:done",
        error: `Scheduler failure: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      this.busy.delete(flow.id);
      const last = hub.lastRun(flow.id);
      this.log(`flow ${flow.id}: run ${runId} ${last?.status ?? "?"} in ${Date.now() - started} ms`);
    }
  }
}

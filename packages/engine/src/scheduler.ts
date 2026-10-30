import type { FileWatchSpec, LifecycleReason, TelegramSpec } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import type { RunHub } from "./hub";
import type { FlowStore } from "./store";
import { validateFlow, type Registry } from "./validate";

export type SchedulerRun = (
  flow: Flow,
  onEvent: (e: RunnerEvent) => void,
  opts: { trigger: string; triggerData?: Json },
) => Promise<void>;

/** Подписка на изменения файлов: возвращает функцию отписки. Реализация — `createFileWatcher` (file-watch.ts). */
export type FileWatchFactory = (spec: FileWatchSpec, onChange: (payload: Json) => void) => () => void;

/** Подписка на обновления Telegram-бота; возвращает функцию отписки. Реализация — `createTelegramPoller`. */
export type TelegramPollFactory = (spec: TelegramSpec, onUpdate: (update: Json) => void) => () => void;

/** Предел очереди необработанных событий (обновления бота); сверх него новые отбрасываются с записью в лог. */
const MAX_EVENT_QUEUE = 500;

export type SchedulerDeps = {
  store: FlowStore;
  hub: RunHub;
  registry: Registry;
  /** Исполнитель запуска (в проде — отдельный процесс-раннер). */
  run: SchedulerRun;
  log?: (msg: string) => void;
  /** Сколько запусков по вебхукам могут идти одновременно; сверх лимита — отказ (HTTP 429). */
  maxConcurrentHookRuns?: number;
  /** Слежение за файлами для Local File Trigger; без него такие триггеры не активируются. */
  watchFiles?: FileWatchFactory;
  /** Опрос Telegram для Telegram Trigger; без него такие триггеры не активируются. */
  pollTelegram?: TelegramPollFactory;
};

/** Слишком много одновременных запусков по вебхукам. */
export class SchedulerBusyError extends Error {
  constructor() {
    super("Too many concurrent webhook runs");
    this.name = "SchedulerBusyError";
  }
}

const DEFAULT_MAX_HOOK_RUNS = 8;

const hookKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

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
  private readonly flows = new Map<string, Flow>();
  /** "METHOD path" → нода-вебхук опубликованного флоу. */
  private readonly hooks = new Map<string, { flowId: string; nodeId: string }>();
  /** Обработчики ошибок: flowId → ноды Error Trigger и список флоу, чьи ошибки они принимают (пусто — любые). */
  private readonly errorHandlers = new Map<string, { nodeId: string; flows: string[] }[]>();
  /** Очередь событий, которые нельзя терять (сообщения бота): запускаются по мере освобождения слотов, по порядку. */
  private eventQueue: { flowId: string; nodeId: string; data: Json }[] = [];
  private hookRuns = 0;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Поднимает расписание всех опубликованных флоу из хранилища (при старте сервера). */
  async start(): Promise<void> {
    const flows = await this.deps.store.list((file, e) =>
      this.log(`skipping unreadable flow file ${file}: ${e instanceof Error ? e.message : String(e)}`),
    );
    for (const flow of flows) this.sync(flow, "startup");
  }

  /**
   * Приводит активацию флоу в соответствие с его состоянием: published — ставит таймеры расписания,
   * регистрирует вебхуки, файловые наблюдатели и обработчики ошибок, иначе снимает всё.
   * `reason` (publish / update / startup) запускает триггеры жизненного цикла этого флоу.
   */
  sync(flow: Flow, reason?: LifecycleReason): void {
    this.clear(flow.id);
    if (flow.status !== "published") return;

    const checked = validateFlow(flow, this.deps.registry);
    if (!checked.ok) {
      this.log(`flow ${flow.id} is published but invalid, not scheduled: ${checked.issues[0]?.message}`);
      return;
    }

    const jobs: Job[] = [];
    const handlers: { nodeId: string; flows: string[] }[] = [];
    const lifecycleNodes: string[] = [];
    for (const node of flow.nodes) {
      const cls = this.deps.registry[node.type];
      if (!cls?.isTrigger) continue;
      try {
        const ms = cls.intervalMs(node.params);
        if (ms !== null) {
          jobs.push({ nodeId: node.id, stop: every(ms, () => void this.fire(flow, node.id)) });
          this.log(`flow ${flow.id}: trigger ${node.id} every ${ms} ms`);
        }
        const hook = cls.webhook(node.params);
        if (hook) {
          const key = hookKey(hook.method, hook.path);
          const owner = this.hooks.get(key);
          if (owner && owner.flowId !== flow.id) {
            this.log(`flow ${flow.id}: webhook ${key} is already used by flow ${owner.flowId}, not registered`);
          } else {
            this.hooks.set(key, { flowId: flow.id, nodeId: node.id });
            this.log(`flow ${flow.id}: webhook ${key} -> trigger ${node.id}`);
          }
        }
        const fw = cls.fileWatch(node.params);
        if (fw) {
          if (!this.deps.watchFiles) {
            this.log(`flow ${flow.id}: trigger ${node.id} needs a file watcher, none is configured`);
          } else {
            const stop = this.deps.watchFiles(fw, (payload) => this.fireEvent(flow.id, node.id, payload));
            jobs.push({ nodeId: node.id, stop });
            this.log(`flow ${flow.id}: trigger ${node.id} watches "${fw.path}" (${fw.event}, ${fw.pattern})`);
          }
        }
        const tg = cls.telegram(node.params);
        if (tg) {
          if (!this.deps.pollTelegram) {
            this.log(`flow ${flow.id}: trigger ${node.id} needs a Telegram poller, none is configured`);
          } else {
            const stop = this.deps.pollTelegram(tg, (update) => this.enqueueEvent(flow.id, node.id, update));
            jobs.push({ nodeId: node.id, stop });
            this.log(`flow ${flow.id}: trigger ${node.id} polls Telegram bot ${tg.token.split(":")[0]} for ${tg.updates.join(", ")}`);
          }
        }
        const scope = cls.errorScope(node.params);
        if (scope) {
          handlers.push({ nodeId: node.id, flows: scope.flows });
          this.log(`flow ${flow.id}: trigger ${node.id} handles errors of ${scope.flows.length ? scope.flows.join(", ") : "all flows"}`);
        }
        const life = cls.lifecycle(node.params);
        if (life && reason && life[reason]) lifecycleNodes.push(node.id);
      } catch (e) {
        this.log(`flow ${flow.id}: trigger ${node.id} not activated: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.flows.set(flow.id, flow);
    if (jobs.length > 0) this.jobs.set(flow.id, jobs);
    if (handlers.length > 0) this.errorHandlers.set(flow.id, handlers);
    // события жизненного цикла — уже после регистрации, отдельной задачей: sync вернётся сразу
    if (reason) {
      for (const nodeId of lifecycleNodes) {
        queueMicrotask(() =>
          this.fireEvent(flow.id, nodeId, {
            event: reason,
            at: new Date().toISOString(),
            flow: { id: flow.id, name: flow.name },
          }),
        );
      }
    }
  }

  /**
   * Что мешает активировать опубликованный флоу: недопустимое расписание или путь вебхука, конфликт пути
   * с другим флоу. Пустой список — можно публиковать. Вызывается до сохранения (в API публикации).
   */
  problems(flow: Flow): string[] {
    const out: string[] = [];
    const own = new Set<string>();
    for (const node of flow.nodes) {
      const cls = this.deps.registry[node.type];
      if (!cls?.isTrigger) continue;
      try {
        cls.intervalMs(node.params);
        cls.fileWatch(node.params);
        cls.telegram(node.params);
        cls.errorScope(node.params);
        cls.lifecycle(node.params);
        const hook = cls.webhook(node.params);
        if (!hook) continue;
        const key = hookKey(hook.method, hook.path);
        const owner = this.hooks.get(key);
        if (owner && owner.flowId !== flow.id) out.push(`Webhook ${key} is already used by flow ${owner.flowId}`);
        else if (own.has(key)) out.push(`Webhook ${key} is used by more than one trigger of this flow`);
        own.add(key);
      } catch (e) {
        out.push(`Trigger ${node.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  isScheduled(flowId: string): boolean {
    return (
      this.jobs.has(flowId) || this.errorHandlers.has(flowId) || [...this.hooks.values()].some((h) => h.flowId === flowId)
    );
  }

  /** Вебхук, слушающий этот метод и путь: точное совпадение метода, затем ANY. */
  findWebhook(method: string, path: string): { flow: Flow; nodeId: string } | undefined {
    const hit = this.hooks.get(hookKey(method, path)) ?? this.hooks.get(hookKey("ANY", path));
    const flow = hit && this.flows.get(hit.flowId);
    return hit && flow ? { flow, nodeId: hit.nodeId } : undefined;
  }

  /**
   * Запуск флоу от триггера с данными (входящий запрос вебхука). Лимит параллельных запусков проверяется
   * СИНХРОННО (бросает `SchedulerBusyError`), чтобы вызывающий мог отказать сразу, не дожидаясь запуска.
   * Возвращает промис завершения запуска; он не отклоняется. `onEvent` получает те же события, что и Watch.
   */
  trigger(
    flowId: string,
    nodeId: string,
    triggerData: Json,
    onEvent?: (e: RunnerEvent) => void,
    opts?: { errorRun?: boolean },
  ): Promise<void> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow "${flowId}" is not published`);
    if (this.hookRuns >= (this.deps.maxConcurrentHookRuns ?? DEFAULT_MAX_HOOK_RUNS)) throw new SchedulerBusyError();
    this.hookRuns++;
    return this.execute(flow, nodeId, triggerData, onEvent, opts).finally(() => {
      this.hookRuns--;
    });
  }

  stop(): void {
    // флоу может быть активен без таймеров (только вебхуки) — чистим по всем известным id
    for (const id of new Set([...this.jobs.keys(), ...this.flows.keys()])) this.clear(id);
  }

  private clear(flowId: string) {
    for (const j of this.jobs.get(flowId) ?? []) j.stop();
    this.jobs.delete(flowId);
    this.errorHandlers.delete(flowId);
    this.eventQueue = this.eventQueue.filter((q) => q.flowId !== flowId);
    for (const [key, h] of [...this.hooks]) if (h.flowId === flowId) this.hooks.delete(key);
    this.flows.delete(flowId);
  }

  private async fire(flow: Flow, nodeId: string): Promise<void> {
    // один запуск флоу за раз: если прошлый ещё идёт — тик пропускаем, а не копим очередь
    if (this.busy.has(flow.id)) {
      this.deps.hub.skip(flow.id, nodeId, "busy");
      this.log(`flow ${flow.id}: tick of ${nodeId} skipped, previous run is still active`);
      return;
    }
    this.busy.add(flow.id);
    try {
      await this.execute(flow, nodeId);
    } finally {
      this.busy.delete(flow.id);
    }
  }

  /**
   * Запуск от события (файл, жизненный цикл, ошибка другого флоу). Занятость — не ошибка: запуск
   * пропускается с пометкой в ленте; причины отказа попадают в лог.
   */
  private fireEvent(flowId: string, nodeId: string, data: Json, opts?: { errorRun?: boolean }): void {
    try {
      void this.trigger(flowId, nodeId, data, undefined, opts);
    } catch (e) {
      if (e instanceof SchedulerBusyError) {
        this.deps.hub.skip(flowId, nodeId, "busy");
        this.log(`flow ${flowId}: event for ${nodeId} skipped, too many concurrent runs`);
      } else {
        this.log(`flow ${flowId}: event for ${nodeId} dropped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Событие, которое нельзя терять (сообщение бота): ждёт свободного слота в очереди, порядок сохраняется.
   * Если очередь переполнена, новое событие отбрасывается — это видно в логе.
   */
  private enqueueEvent(flowId: string, nodeId: string, data: Json): void {
    if (this.eventQueue.length >= MAX_EVENT_QUEUE) {
      this.log(`flow ${flowId}: event queue is full (${MAX_EVENT_QUEUE}), event for ${nodeId} dropped`);
      return;
    }
    this.eventQueue.push({ flowId, nodeId, data });
    this.drainQueue();
  }

  private drainQueue(): void {
    const limit = this.deps.maxConcurrentHookRuns ?? DEFAULT_MAX_HOOK_RUNS;
    while (this.eventQueue.length > 0 && this.hookRuns < limit) {
      const next = this.eventQueue.shift()!;
      if (!this.flows.has(next.flowId)) continue; // флоу сняли с публикации, пока событие ждало
      try {
        void this.trigger(next.flowId, next.nodeId, next.data).finally(() => this.drainQueue());
      } catch (e) {
        this.log(`flow ${next.flowId}: queued event for ${next.nodeId} dropped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Передаёт ошибку запуска всем подходящим Error Trigger. */
  private dispatchError(flow: Flow, runId: string, trigger: string, message: string, node: string | null): void {
    const payload: Json = {
      flow: { id: flow.id, name: flow.name },
      run: { id: runId, trigger },
      error: { message, node },
      at: new Date().toISOString(),
    };
    for (const [handlerFlowId, handlers] of [...this.errorHandlers]) {
      for (const h of handlers) {
        if (h.flows.length > 0 && !h.flows.includes(flow.id)) continue;
        this.fireEvent(handlerFlowId, h.nodeId, payload, { errorRun: true });
      }
    }
  }

  /**
   * Один запуск: события идут в хаб (Watch) и, если задан, в `extra`. Никогда не бросает.
   * Упавший запуск (кроме запуска самого обработчика ошибок — иначе была бы цепочка) уходит в Error Trigger.
   */
  private async execute(
    flow: Flow,
    nodeId: string,
    triggerData?: Json,
    extra?: (e: RunnerEvent) => void,
    opts?: { errorRun?: boolean },
  ): Promise<void> {
    const { hub } = this.deps;
    const runId = hub.startRun(flow.id, nodeId);
    const started = Date.now();
    let failedNode: string | null = null;
    let nodeMessage: string | undefined;
    let failure: string | undefined;
    const emit = (e: RunnerEvent) => {
      if (e.event === "node:error") {
        failedNode = e.nodeId;
        nodeMessage = e.error;
      } else if (e.event === "flow:done" && e.error !== undefined) failure = e.error;
      hub.publish(flow.id, runId, e);
      try {
        extra?.(e);
      } catch {
        // сломанный потребитель событий не должен ронять запуск
      }
    };
    try {
      await this.deps.run(flow, emit, { trigger: nodeId, triggerData });
    } catch (e) {
      // run не должен бросать, но если бросил — запуск обязан закрыться событием
      emit({
        event: "flow:done",
        error: `Scheduler failure: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      const last = hub.lastRun(flow.id);
      this.log(`flow ${flow.id}: run ${runId} ${last?.status ?? "?"} in ${Date.now() - started} ms`);
      // обработчику — собственное сообщение упавшей ноды, а не обёртка итога («Node "x" failed: …»);
      // если нода не называлась (невалидный флоу, падение процесса) — сообщение итога запуска
      if (failure !== undefined && !opts?.errorRun) {
        this.dispatchError(flow, runId, nodeId, nodeMessage ?? failure, failedNode);
      }
    }
  }
}

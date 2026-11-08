import type { FileWatchSpec, LifecycleReason, MailWatchSpec, TelegramSpec } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import type { RunHub } from "./hub";
import type { FlowStore } from "./store";
import { participatingNodes } from "./participants";
import { findIncoming } from "./call-channel";
import { validateFlow, type Registry } from "./validate";

export type SchedulerRun = (
  flow: Flow,
  onEvent: (e: RunnerEvent) => void,
  opts: { trigger: string; triggerData?: Json; onResolveCall?: (channelId: string) => Promise<{ flow: Flow; triggerId: string }> },
) => Promise<void>;

/** Subscription to file changes: returns the unsubscribe function. Implemented by `createFileWatcher` (file-watch.ts). */
export type FileWatchFactory = (spec: FileWatchSpec, onChange: (payload: Json) => void) => () => void;

/** Mailbox polling for Mail Trigger: calls `onMail` for every new message; returns the stop function. Implemented by `createMailPoller`. */
export type MailPollFactory = (spec: MailWatchSpec, onMail: (message: Json) => void) => () => void;

/** Subscription to Telegram bot updates; returns the unsubscribe function. Implemented by `createTelegramPoller`. */
export type TelegramPollFactory = (spec: TelegramSpec, onUpdate: (update: Json) => void) => () => void;

/** Limit of the queue of unprocessed events (bot updates); beyond it new ones are dropped with a log entry. */
const MAX_EVENT_QUEUE = 500;

export type SchedulerDeps = {
  store: FlowStore;
  hub: RunHub;
  registry: Registry;
  /** Run executor (in production, a separate runner process). */
  run: SchedulerRun;
  log?: (msg: string) => void;
  /** How many webhook runs may go at once; beyond the limit, refuse (HTTP 429). */
  maxConcurrentHookRuns?: number;
  /** File watching for Local File Trigger; without it such triggers are not activated. */
  watchFiles?: FileWatchFactory;
  /** Telegram polling for Telegram Trigger; without it such triggers are not activated. */
  pollTelegram?: TelegramPollFactory;
  /** Mail polling for Mail Trigger; without it such triggers are not activated. */
  pollMail?: MailPollFactory;
};

/** Too many concurrent webhook runs. */
export class SchedulerBusyError extends Error {
  constructor() {
    super("Too many concurrent webhook runs");
    this.name = "SchedulerBusyError";
  }
}

const DEFAULT_MAX_HOOK_RUNS = 8;

const hookKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

/** setTimeout cannot handle delays > 2^31-1 ms (it fires immediately), so long periods are split into chunks. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Periodic call of `fn` every `ms`; a chain of timers that accumulates no drift from fn's execution time. */
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
        arm(); // schedule the next tick first, independent of how long fn takes
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
 * Scheduler: for every published flow, sets timers for its trigger nodes
 * (the period comes from the block itself via `intervalMs`) and starts the flow from the trigger that fired.
 * Runs on the server, regardless of whether the UI is open.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job[]>();
  private readonly busy = new Set<string>();
  private readonly flows = new Map<string, Flow>();
  /** "METHOD path" → the webhook node of a published flow. */
  private readonly hooks = new Map<string, { flowId: string; nodeId: string }>();
  /** Error handlers: flowId → Error Trigger nodes and the list of flows whose errors they accept (empty: any). */
  private readonly errorHandlers = new Map<string, { nodeId: string; flows: string[] }[]>();
  /** Queue of events that must not be lost (bot messages): started as slots free up, in order. */
  private eventQueue: { flowId: string; nodeId: string; data: Json }[] = [];
  private hookRuns = 0;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Brings up the schedule of all published flows from the store (at server start). */
  async start(): Promise<void> {
    const flows = await this.deps.store.list((file, e) =>
      this.log(`skipping unreadable flow file ${file}: ${e instanceof Error ? e.message : String(e)}`),
    );
    for (const flow of flows) this.sync(flow, "startup");
  }

  /**
   * Brings a flow's activation in line with its state: published sets the schedule timers,
   * registers webhooks, file watchers and error handlers; otherwise removes everything.
   * `reason` (publish / update / startup) starts this flow's lifecycle triggers.
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
      if (!cls?.isTrigger || node.disabled) continue; // a disabled trigger is not registered (timer, webhook, poll)
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
            this.log(`flow ${flow.id}: trigger ${node.id} ${tg.mode === "webhook" ? "receives webhooks of" : "polls"} Telegram bot ${tg.token.split(":")[0]} for ${tg.updates.join(", ")}`);
          }
        }
        const mail = cls.mailWatch(node.params);
        if (mail) {
          if (!this.deps.pollMail) {
            this.log(`flow ${flow.id}: trigger ${node.id} needs a mail poller, none is configured`);
          } else {
            const stop = this.deps.pollMail(mail, (message) => this.enqueueEvent(flow.id, node.id, message));
            jobs.push({ nodeId: node.id, stop });
            this.log(`flow ${flow.id}: trigger ${node.id} polls mailbox ${String(mail.connection["provider"] ?? "imap")}:${mail.username} (${mail.folder}) every ${mail.intervalSec} s`);
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
    // lifecycle events come after registration, as a separate task: sync returns immediately
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
   * What prevents activating a published flow: an invalid schedule or webhook path, a path conflict
   * with another flow. An empty list means it can be published. Called before saving (in the publish API).
   */
  problems(flow: Flow): string[] {
    const out: string[] = [];
    const own = new Set<string>();
    for (const node of flow.nodes) {
      const cls = this.deps.registry[node.type];
      if (!cls?.isTrigger || node.disabled) continue; // a disabled trigger is not registered (timer, webhook, poll)
      try {
        cls.intervalMs(node.params);
        cls.fileWatch(node.params);
        cls.telegram(node.params);
        cls.mailWatch(node.params);
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

  /** The webhook listening on this method and path: exact method match first, then ANY. */
  findWebhook(method: string, path: string): { flow: Flow; nodeId: string } | undefined {
    const hit = this.hooks.get(hookKey(method, path)) ?? this.hooks.get(hookKey("ANY", path));
    const flow = hit && this.flows.get(hit.flowId);
    return hit && flow ? { flow, nodeId: hit.nodeId } : undefined;
  }

  /**
   * Run a flow from a trigger with data (an incoming webhook request). The concurrent-run limit is checked
   * SYNCHRONOUSLY (throws `SchedulerBusyError`) so the caller can refuse immediately without waiting for the run.
   * Returns the run completion promise; it never rejects. `onEvent` receives the same events as Watch.
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

  /**
   * The flow and trigger for a call by channel (outgoing call): exactly one incoming call among PUBLISHED flows. The runner
   * executes the called flow as a nested run in its own process, so the flow definition itself is returned.
   */
  resolveCall(channelId: string): Promise<{ flow: Flow; triggerId: string }> {
    try {
      return Promise.resolve(findIncoming([...this.flows.values()], channelId));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  stop(): void {
    // a flow can be active without timers (webhooks only), so clean up across all known ids
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
    // one run of a flow at a time: if the previous one is still going, skip the tick rather than build a queue
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
   * Run from an event (file, lifecycle, another flow's error). Being busy is not an error: the run
   * is skipped with a note in the feed; refusal reasons go to the log.
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
   * An event that must not be lost (a bot message): waits for a free slot in the queue, order is preserved.
   * If the queue is full, the new event is dropped; this is visible in the log.
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
      if (!this.flows.has(next.flowId)) continue; // the flow was unpublished while the event waited
      try {
        void this.trigger(next.flowId, next.nodeId, next.data).finally(() => this.drainQueue());
      } catch (e) {
        this.log(`flow ${next.flowId}: queued event for ${next.nodeId} dropped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Passes the run's error to all matching Error Triggers. */
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
   * One run: events go to the hub (Watch) and, if given, to `extra`. Never throws.
   * A failed run (except the run of the error handler itself, otherwise there would be a chain) goes to Error Trigger.
   */
  private async execute(
    flow: Flow,
    nodeId: string,
    triggerData?: Json,
    extra?: (e: RunnerEvent) => void,
    opts?: { errorRun?: boolean },
  ): Promise<void> {
    const { hub } = this.deps;
    const runId = hub.startRun(flow.id, nodeId, [...participatingNodes(flow, this.deps.registry, nodeId)]);
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
        // a broken event consumer must not crash the run
      }
    };
    try {
      // calls by channel (outgoing call): a working run finds only published flows
      await this.deps.run(flow, emit, { trigger: nodeId, triggerData, onResolveCall: (ch) => this.resolveCall(ch) });
    } catch (e) {
      // run must not throw, but if it did, the run must close with an event
      emit({
        event: "flow:done",
        error: `Scheduler failure: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      const last = hub.lastRun(flow.id);
      this.log(`flow ${flow.id}: run ${runId} ${last?.status ?? "?"} in ${Date.now() - started} ms`);
      // the handler gets the failed node's own message, not the run summary wrapper ("Node "x" failed: …");
      // if no node was named (invalid flow, process crash), the run summary message
      if (failure !== undefined && !opts?.errorRun) {
        this.dispatchError(flow, runId, nodeId, nodeMessage ?? failure, failedNode);
      }
    }
  }
}

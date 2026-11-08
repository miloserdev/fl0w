import type { RunnerEvent, WatchMessage } from "@fl0w/schema";

export type RunSummary = {
  runId: string;
  trigger: string | null;
  /** Nodes taking part in the run (the branch from the trigger): the UI resets exactly their state. */
  nodes?: string[];
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "error";
  error?: string;
};

type RunRecord = RunSummary & { events: RunnerEvent[] };

type FlowChannel = { last?: RunRecord; listeners: Set<(m: WatchMessage) => void> };

// a run with a huge log must not bloat the hub's memory; live subscribers still receive every event
const MAX_BUFFERED_EVENTS = 5000;

/**
  * Live feed of flow runs (for Watch): publishes events, remembers the last run
  * and replays it from the start on connect, so a subscriber sees what is going on even when joining mid-run.
 */
export class RunHub {
  private readonly channels = new Map<string, FlowChannel>();
  private seq = 0;

  private channel(flowId: string): FlowChannel {
    let c = this.channels.get(flowId);
    if (!c) this.channels.set(flowId, (c = { listeners: new Set() }));
    return c;
  }

  private emit(c: FlowChannel, m: WatchMessage) {
    for (const l of [...c.listeners]) {
      try {
        l(m);
      } catch {
        // a broken subscriber must not disturb the others or the run
      }
    }
  }

  startRun(flowId: string, trigger: string | null, nodes?: string[]): string {
    const c = this.channel(flowId);
    const runId = `run_${Date.now().toString(36)}_${(++this.seq).toString(36)}`;
    const startedAt = new Date().toISOString();
    c.last = { runId, trigger, nodes, startedAt, status: "running", events: [] };
    this.emit(c, { type: "run:start", runId, flowId, trigger, ...(nodes ? { nodes } : {}), at: startedAt });
    return runId;
  }

  publish(flowId: string, runId: string, event: RunnerEvent) {
    const c = this.channel(flowId);
    const rec = c.last;
    if (rec && rec.runId === runId) {
      if (rec.events.length < MAX_BUFFERED_EVENTS) rec.events.push(event);
      if (event.event === "flow:done") {
        rec.finishedAt = new Date().toISOString();
        rec.status = event.error === undefined ? "done" : "error";
        if (event.error !== undefined) rec.error = event.error;
      }
    }
    this.emit(c, { type: "run:event", runId, event });
  }

  skip(flowId: string, trigger: string, reason: "busy") {
    this.emit(this.channel(flowId), { type: "run:skip", flowId, trigger, at: new Date().toISOString(), reason });
  }

  /** Subscribe; immediately replays the last run. Returns the unsubscribe function. */
  subscribe(flowId: string, listener: (m: WatchMessage) => void): () => void {
    const c = this.channel(flowId);
    const rec = c.last;
    if (rec) {
      listener({ type: "run:start", runId: rec.runId, flowId, trigger: rec.trigger, ...(rec.nodes ? { nodes: rec.nodes } : {}), at: rec.startedAt });
      for (const event of rec.events) listener({ type: "run:event", runId: rec.runId, event });
    }
    c.listeners.add(listener);
    return () => {
      c.listeners.delete(listener);
    };
  }

  lastRun(flowId: string): RunSummary | undefined {
    const rec = this.channels.get(flowId)?.last;
    if (!rec) return undefined;
    const { events: _events, ...summary } = rec;
    return summary;
  }
}

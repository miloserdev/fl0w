import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow, Json, RunnerEvent, WatchMessage } from "@fl0w/schema";
import { RunHub } from "./hub";
import { Scheduler, SchedulerBusyError, type SchedulerRun } from "./scheduler";
import { FlowStore } from "./store";
import { edge, flow, node, testRegistry } from "./test-helpers";

const published = (
  id: string,
  every: { interval: number; unit: string } = { interval: 1, unit: "seconds" },
  status: "published" | "draft" = "published",
): Flow => ({
  ...flow([node("t", "every", every), node("r", "result")], [edge("t", "r")]),
  id,
  status,
});

function setup(run?: SchedulerRun) {
  const calls: { flowId: string; trigger: string; triggerData?: Json }[] = [];
  const hub = new RunHub();
  const logs: string[] = [];
  const impl: SchedulerRun =
    run ??
    (async (f, onEvent, o) => {
      calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
      onEvent({ event: "node:start", nodeId: o.trigger });
      onEvent({ event: "flow:done", result: 1 });
    });
  const wrapped: SchedulerRun = async (f, onEvent, o) => {
    if (run) calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
    await impl(f, onEvent, o);
  };
  const store = new FlowStore("/nonexistent");
  const scheduler = new Scheduler({
    store,
    hub,
    registry: testRegistry,
    run: wrapped,
    log: (m) => logs.push(m),
    maxConcurrentHookRuns: 2,
  });
  return { scheduler, hub, calls, logs, store };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Scheduler", () => {
  it("starts the flow from a trigger on the period, not immediately", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("f1", { interval: 5, unit: "seconds" }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ flowId: "f1", trigger: "t" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    scheduler.stop();
  });

  it("minutes and hours are converted to ms", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("m", { interval: 2, unit: "minutes" }));
    scheduler.sync(published("h", { interval: 1, unit: "hours" }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.map((c) => c.flowId)).toEqual(["m"]);
    await vi.advanceTimersByTimeAsync(3_600_000 - 120_000);
    expect(calls.filter((c) => c.flowId === "h")).toHaveLength(1);
    scheduler.stop();
  });

  it("draft and unpublishing stop the schedule", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("f"));
    expect(scheduler.isScheduled("f")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);

    scheduler.sync({ ...published("f"), status: "draft" });
    expect(scheduler.isScheduled("f")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);

    scheduler.sync(published("g", undefined, "draft"));
    expect(scheduler.isScheduled("g")).toBe(false);
  });

  it("republishing replaces the schedule rather than duplicating it", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("f", { interval: 1, unit: "seconds" }));
    scheduler.sync(published("f", { interval: 1, unit: "seconds" }));
    scheduler.sync(published("f", { interval: 10, unit: "seconds" }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toEqual([]); // the old 1 s period no longer works
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it("an invalid published flow is not scheduled", async () => {
    const { scheduler, calls, logs } = setup();
    scheduler.sync(published("bad", { interval: 0, unit: "seconds" })); // interval < min
    scheduler.sync(published("bad2", { interval: 1, unit: "weeks" })); // unknown unit
    expect(scheduler.isScheduled("bad")).toBe(false);
    expect(scheduler.isScheduled("bad2")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/invalid, not scheduled/);
  });

  it("a published flow without triggers is not scheduled", () => {
    const { scheduler } = setup();
    scheduler.sync({ ...flow([node("s", "source", { json: 1 })], []), id: "nt", status: "published" });
    expect(scheduler.isScheduled("nt")).toBe(false);
  });

  it("while the previous run is going, the tick is skipped and this is reported", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { scheduler, hub, calls } = setup(async (_f, onEvent) => {
      await hold;
      onEvent({ event: "flow:done" });
    });
    const msgs: WatchMessage[] = [];
    hub.subscribe("f", (m) => msgs.push(m));
    scheduler.sync(published("f"));

    await vi.advanceTimersByTimeAsync(3_000); // three ticks, the first run still hangs
    expect(calls).toHaveLength(1);
    expect(msgs.filter((m) => m.type === "run:skip")).toHaveLength(2);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2); // after it finished the schedule resumed
    scheduler.stop();
  });

  it("run events reach the hub: start, nodes, result", async () => {
    const { scheduler, hub } = setup();
    const msgs: WatchMessage[] = [];
    hub.subscribe("f", (m) => msgs.push(m));
    scheduler.sync(published("f"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(msgs.map((m) => (m.type === "run:event" ? m.event.event : m.type))).toEqual([
      "run:start",
      "node:start",
      "flow:done",
    ]);
    expect(msgs[0]).toMatchObject({ trigger: "t" });
    expect(hub.lastRun("f")?.status).toBe("done");
    scheduler.stop();
  });

  it("an executor exception closes the run with an error, and the schedule lives on", async () => {
    let n = 0;
    const { scheduler, hub } = setup(async () => {
      n++;
      throw new Error("executor exploded");
    });
    scheduler.sync(published("f"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.lastRun("f")).toMatchObject({ status: "error", error: expect.stringMatching(/executor exploded/) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(n).toBe(3);
    scheduler.stop();
  });

  it("periods longer than the setTimeout limit (24.8 days) do not fire immediately", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("long", { interval: 1000, unit: "hours" })); // ~41.7 days
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000 * 3_600_000 - 60_000);
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it("stop removes all timers", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("a"));
    scheduler.sync(published("b"));
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Scheduler.start: bring-up after a restart", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fl0w-sched-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("takes only published flows from the store", async () => {
    vi.useRealTimers();
    const store = new FlowStore(dir);
    await store.put(published("on"));
    await store.put(published("off", undefined, "draft"));
    const hub = new RunHub();
    const scheduler = new Scheduler({
      store,
      hub,
      registry: testRegistry,
      run: async (_f, onEvent) => {
        onEvent({ event: "flow:done" });
      },
    });
    await scheduler.start();
    expect(scheduler.isScheduled("on")).toBe(true);
    expect(scheduler.isScheduled("off")).toBe(false);
    scheduler.stop();
  });
});

const hookFlow = (
  id: string,
  path = "orders",
  method = "POST",
  status: "published" | "draft" = "published",
  extra: Flow["nodes"] = [],
): Flow => ({
  ...flow([node("w", "webhook", { path, method }), node("r", "result"), ...extra], [edge("w", "r")]),
  id,
  status,
});

describe("Scheduler: webhooks", () => {
  it("a published webhook is registered; the path is normalised; the method is exact, ANY matches any", () => {
    const { scheduler } = setup();
    scheduler.sync(hookFlow("a", "/orders/new/", "POST"));
    scheduler.sync(hookFlow("b", "any-path", "ANY"));
    expect(scheduler.findWebhook("POST", "orders/new")).toMatchObject({ nodeId: "w", flow: { id: "a" } });
    expect(scheduler.findWebhook("post", "orders/new")?.flow.id).toBe("a"); // method case does not matter
    expect(scheduler.findWebhook("GET", "orders/new")).toBeUndefined();
    expect(scheduler.findWebhook("DELETE", "any-path")?.flow.id).toBe("b");
    expect(scheduler.findWebhook("POST", "nope")).toBeUndefined();
    expect(scheduler.isScheduled("a")).toBe(true); // active even without timers
  });

  it("draft and unpublishing remove the webhook; republishing moves it", () => {
    const { scheduler } = setup();
    scheduler.sync(hookFlow("a", "one"));
    scheduler.sync(hookFlow("a", "two"));
    expect(scheduler.findWebhook("POST", "one")).toBeUndefined();
    expect(scheduler.findWebhook("POST", "two")).toBeDefined();
    scheduler.sync(hookFlow("a", "two", "POST", "draft"));
    expect(scheduler.findWebhook("POST", "two")).toBeUndefined();
    expect(scheduler.isScheduled("a")).toBe(false);
    scheduler.sync(hookFlow("d", "three", "POST", "draft"));
    expect(scheduler.findWebhook("POST", "three")).toBeUndefined();
  });

  it("path conflict: the second flow does not hijack someone else's webhook; problems() reports it in advance", () => {
    const { scheduler, logs } = setup();
    scheduler.sync(hookFlow("first", "shared"));
    expect(scheduler.problems(hookFlow("second", "shared"))).toEqual(["Webhook POST shared is already used by flow first"]);
    expect(scheduler.problems(hookFlow("first", "shared"))).toEqual([]); // its own path on update is not a conflict
    scheduler.sync(hookFlow("second", "shared"));
    expect(scheduler.findWebhook("POST", "shared")?.flow.id).toBe("first");
    expect(logs.join("\n")).toMatch(/already used by flow first/);
    scheduler.sync(hookFlow("first", "shared", "POST", "draft")); // released it: the path is available again
    scheduler.sync(hookFlow("second", "shared"));
    expect(scheduler.findWebhook("POST", "shared")?.flow.id).toBe("second");
  });

  it("problems(): a bad path, a duplicate within a flow, a bad schedule", () => {
    const { scheduler } = setup();
    expect(scheduler.problems(hookFlow("a", "a b"))[0]).toMatch(/Invalid webhook path/);
    const twice = hookFlow("a", "x", "POST", "published", [node("w2", "webhook", { path: "x", method: "POST" })]);
    expect(scheduler.problems(twice)).toEqual(["Webhook POST x is used by more than one trigger of this flow"]);
    expect(scheduler.problems(published("e", { interval: 1, unit: "weeks" }))[0]).toMatch(/Unknown unit/);
    expect(scheduler.problems(published("ok"))).toEqual([]);
  });

  it("trigger starts the flow from the right node with the request data; events go to the hub and to the caller", async () => {
    const { scheduler, hub, calls } = setup();
    scheduler.sync(hookFlow("a"));
    const msgs: WatchMessage[] = [];
    hub.subscribe("a", (m) => msgs.push(m));
    const seen: RunnerEvent[] = [];
    const payload = { method: "POST", body: { id: 1 } };
    await scheduler.trigger("a", "w", payload, (e) => void seen.push(e));
    expect(calls).toEqual([{ flowId: "a", trigger: "w", triggerData: payload }]);
    expect(seen.map((e) => e.event)).toEqual(["node:start", "flow:done"]);
    expect(msgs.map((m) => (m.type === "run:event" ? m.event.event : m.type))).toEqual(["run:start", "node:start", "flow:done"]);
    expect(hub.lastRun("a")?.status).toBe("done");
    // the run's branch (the trigger and reachable nodes) goes into run:start; Watch uses it to reset the state of only those nodes
    expect(msgs[0]).toMatchObject({ type: "run:start", trigger: "w" });
    const start = msgs[0];
    expect(start?.type === "run:start" ? start.nodes : undefined).toContain("w");
  });

  it("the concurrent-run limit is checked synchronously and freed after completion", async () => {
    const releases: (() => void)[] = [];
    const { scheduler } = setup(async (_f, onEvent) => {
      await new Promise<void>((r) => releases.push(r));
      onEvent({ event: "flow:done" });
    });
    scheduler.sync(hookFlow("a"));
    const p1 = scheduler.trigger("a", "w", {});
    const p2 = scheduler.trigger("a", "w", {});
    expect(() => scheduler.trigger("a", "w", {})).toThrow(SchedulerBusyError); // limit = 2
    releases[0]!();
    await p1;
    const p3 = scheduler.trigger("a", "w", {}); // the slot freed up
    releases.slice(1).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    releases.forEach((r) => r());
    await Promise.all([p2, p3]);
    expect(() => scheduler.trigger("a", "w", {})).not.toThrow();
  });

  it("a webhook run is not blocked by a scheduled run of the same flow", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { scheduler, calls } = setup(async (_f, onEvent) => {
      await hold;
      onEvent({ event: "flow:done" });
    });
    const mixed: Flow = {
      ...flow(
        [node("t", "every", { interval: 1, unit: "seconds" }), node("w", "webhook", { path: "p" }), node("r1", "result"), node("r2", "result")],
        [edge("t", "r1"), edge("w", "r2")],
      ),
      id: "mix",
      status: "published",
    };
    scheduler.sync(mixed);
    await vi.advanceTimersByTimeAsync(1000); // the scheduled run hung
    expect(calls).toHaveLength(1);
    void scheduler.trigger("mix", "w", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.trigger)).toEqual(["t", "w"]);
    release();
    scheduler.stop();
  });

  it("trigger of an unpublished flow is an error", () => {
    const { scheduler } = setup();
    expect(() => scheduler.trigger("ghost", "w", {})).toThrow(/not published/);
    scheduler.sync(hookFlow("a"));
    scheduler.sync(hookFlow("a", "orders", "POST", "draft"));
    expect(() => scheduler.trigger("a", "w", {})).toThrow(/not published/);
  });

  it("stop removes webhooks", () => {
    const { scheduler } = setup();
    scheduler.sync(hookFlow("a"));
    scheduler.stop();
    expect(scheduler.findWebhook("POST", "orders")).toBeUndefined();
  });
});

const withNodes = (id: string, nodes: Flow["nodes"], status: "published" | "draft" = "published"): Flow => ({
  ...flow([...nodes, node("r", "result")], [edge(nodes[0]!.id, "r")]),
  id,
  status,
});

describe("Scheduler: flow lifecycle", () => {
  const activation = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("t", "activation_trigger", params)], status);

  it("publish / update / startup fire only on their own reason", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(activation("a"), "publish");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => (c.triggerData as { event: string }).event)).toEqual(["publish"]);
    scheduler.sync(activation("a"), "update");
    scheduler.sync(activation("a"), "startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => (c.triggerData as { event: string }).event)).toEqual(["publish", "update", "startup"]);
    scheduler.stop();
  });

  it("without a reason sync starts nothing; draft too", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(activation("a"));
    scheduler.sync(activation("b", {}, "draft"), "publish");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
  });

  it("the onPublish/onUpdate/onStartup flags disable events", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(activation("a", { onPublish: false, onUpdate: false }), "publish");
    scheduler.sync(activation("a", { onPublish: false, onUpdate: false }), "update");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    scheduler.sync(activation("a", { onPublish: false, onUpdate: false }), "startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  it("Workflow Trigger does not react to server start", async () => {
    const { scheduler, calls } = setup();
    const f = withNodes("w", [node("t", "workflow_trigger")]);
    scheduler.sync(f, "startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    scheduler.sync(f, "publish");
    scheduler.sync(f, "update");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });

  it("event data: reason, time and flow", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync({ ...activation("a"), name: "My flow" }, "publish");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({ flowId: "a", trigger: "t", triggerData: { event: "publish", flow: { id: "a", name: "My flow" }, at: expect.any(String) } });
  });

  it("start() brings up flows from the store with reason startup", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "fl0w-life-"));
    try {
      const store = new FlowStore(dir);
      await store.put(activation("persisted"));
      await store.put(activation("draft-one", {}, "draft"));
      const calls: string[] = [];
      const scheduler = new Scheduler({
        store,
        hub: new RunHub(),
        registry: testRegistry,
        run: async (f, onEvent, o) => {
          calls.push(`${f.id}:${(o.triggerData as { event: string }).event}`);
          onEvent({ event: "flow:done" });
        },
      });
      await scheduler.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual(["persisted:startup"]);
      scheduler.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Scheduler: Error Trigger", () => {
  const failing = (id: string) => withNodes(id, [node("t", "every", { interval: 1, unit: "seconds" })]);
  const handler = (id: string, flows: string[] = []) => withNodes(id, [node("h", "error_trigger", { flows })]);

  /** A run of a "failing" flow gives flow:done with an error and node:error; handlers finish successfully. */
  const runner = (failIds: string[]) =>
    setup(async (f, onEvent) => {
      if (failIds.includes(f.id)) {
        onEvent({ event: "node:error", nodeId: "boomNode", error: "kaboom" });
        onEvent({ event: "flow:done", error: 'Node "boomNode" failed: kaboom' });
      } else onEvent({ event: "flow:done" });
    });

  it("a failed automatic run calls the handler with the error details", async () => {
    const { scheduler, calls } = runner(["bad"]);
    scheduler.sync(handler("h1"));
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.flowId)).toEqual(["bad", "h1"]);
    expect(calls[1]).toMatchObject({
      trigger: "h",
      triggerData: {
        flow: { id: "bad", name: "test" },
        run: { id: expect.stringMatching(/^run_/), trigger: "t" },
        error: { message: "kaboom", node: "boomNode" }, // the node's own message, without the result wrapper
        at: expect.any(String),
      },
    });
    scheduler.stop();
  });

  it("if it was not a node that failed (process, invalid flow), the run summary message and node: null", async () => {
    const { scheduler, calls } = setup(async (f, onEvent) => {
      onEvent({ event: "flow:done", error: f.id === "bad" ? "Runner exited unexpectedly (code 3)" : undefined });
    });
    scheduler.sync(handler("h1"));
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[1]!.triggerData).toMatchObject({ error: { message: "Runner exited unexpectedly (code 3)", node: null } });
    scheduler.stop();
  });

  it("successful runs do not call the handler", async () => {
    const { scheduler, calls } = runner([]);
    scheduler.sync(handler("h1"));
    scheduler.sync(failing("good"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.map((c) => c.flowId)).toEqual(["good", "good", "good"]);
    scheduler.stop();
  });

  it("the flows list limits the scope; an empty list means any flows", async () => {
    const { scheduler, calls } = runner(["bad1", "bad2"]);
    scheduler.sync(handler("only1", ["bad1"]));
    scheduler.sync(handler("all"));
    scheduler.sync(failing("bad1"));
    scheduler.sync(failing("bad2"));
    await vi.advanceTimersByTimeAsync(1000);
    const byHandler = (id: string) => calls.filter((c) => c.flowId === id).map((c) => (c.triggerData as { flow: { id: string } }).flow.id).sort();
    expect(byHandler("only1")).toEqual(["bad1"]);
    expect(byHandler("all")).toEqual(["bad1", "bad2"]);
    scheduler.stop();
  });

  it("the handler is not called for unpublished and unpublished-later flows; removing the handler disables it", async () => {
    const { scheduler, calls } = runner(["bad"]);
    scheduler.sync(handler("h1"));
    scheduler.sync({ ...handler("h2"), status: "draft" });
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.flowId === "h2")).toEqual([]);
    expect(calls.filter((c) => c.flowId === "h1")).toHaveLength(1);
    scheduler.sync({ ...handler("h1"), status: "draft" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.flowId === "h1")).toHaveLength(1);
    scheduler.stop();
  });

  it("a failure of the handler itself does not create a chain; a flow can handle its own errors", async () => {
    const { scheduler, calls } = runner(["selfy", "h1"]);
    scheduler.sync(handler("h1")); // a handler that fails itself
    scheduler.sync(failing("selfy"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.flowId)).toEqual(["selfy", "h1"]); // h1 failed, but there are no new calls
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);

    const both = withNodes("both", [node("t", "every", { interval: 1, unit: "seconds" }), node("h", "error_trigger")]);
    const second = runner(["both"]);
    second.scheduler.sync(both);
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.calls.map((c) => c.trigger)).toEqual(["t", "h"]); // its own handler (as in n8n)
    scheduler.stop();
    second.scheduler.stop();
  });

  it("when the concurrent-run limit is exhausted the handler is skipped without an exception", async () => {
    const releases: (() => void)[] = [];
    const { scheduler, hub } = setup(async (f, onEvent) => {
      if (f.id === "bad") {
        onEvent({ event: "flow:done", error: "boom" });
        return;
      }
      await new Promise<void>((r) => releases.push(r)); // handlers hang and occupy slots
      onEvent({ event: "flow:done" });
    });
    const msgs: WatchMessage[] = [];
    scheduler.sync(handler("h1"));
    scheduler.sync(handler("h2"));
    scheduler.sync(handler("h3"));
    hub.subscribe("h3", (m) => void msgs.push(m));
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000); // limit 2: the third handler is refused
    expect(releases).toHaveLength(2);
    expect(msgs.some((m) => m.type === "run:skip")).toBe(true);
    releases.forEach((r) => r());
    scheduler.stop();
  });

  it("problems() reports bad handler parameters", () => {
    const { scheduler } = setup();
    expect(scheduler.problems(handler("h", ["a"]))).toEqual([]);
    expect(scheduler.problems(withNodes("h", [node("h", "error_trigger", { flows: [1] })]))[0]).toMatch(/list of strings/);
  });
});

describe("Scheduler: Local File Trigger", () => {
  const fileFlow = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("f", "local_file_trigger", params)], status);

  function watcherSetup() {
    const watchers: { spec: unknown; emit: (p: Json) => void; stopped: boolean }[] = [];
    const base = setup();
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent, o) => {
        base.calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      maxConcurrentHookRuns: 2,
      watchFiles: (spec, onChange) => {
        const w = { spec, emit: onChange, stopped: false };
        watchers.push(w);
        return () => void (w.stopped = true);
      },
    });
    return { ...base, scheduler, watchers };
  }

  it("publishing sets a watcher with normalised parameters; an event starts the flow with the file data", async () => {
    const { scheduler, watchers, calls } = watcherSetup();
    scheduler.sync(fileFlow("a", { path: "./inbox/", event: "add", pattern: "*.csv", recursive: true }));
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.spec).toEqual({ path: "inbox", event: "add", pattern: "*.csv", recursive: true });
    const payload = { event: "add", path: "inbox/a.csv", name: "a.csv", size: 3, modifiedAt: "x" };
    watchers[0]!.emit(payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ flowId: "a", trigger: "f", triggerData: payload }]);
    expect(scheduler.isScheduled("a")).toBe(true);
  });

  it("unpublishing, republishing and stop unsubscribe the watcher", () => {
    const { scheduler, watchers } = watcherSetup();
    scheduler.sync(fileFlow("a"));
    scheduler.sync(fileFlow("a", { path: "other" })); // republishing replaces the watcher
    expect(watchers.map((w) => w.stopped)).toEqual([true, false]);
    scheduler.sync(fileFlow("a", {}, "draft"));
    expect(watchers.map((w) => w.stopped)).toEqual([true, true]);
    scheduler.sync(fileFlow("b"));
    scheduler.stop();
    expect(watchers.every((w) => w.stopped)).toBe(true);
    expect(scheduler.isScheduled("b")).toBe(false);
  });

  it("a bad path is not activated and is visible in problems(); without a watcher, a log entry", () => {
    const { scheduler, logs, watchers } = watcherSetup();
    expect(scheduler.problems(fileFlow("a", { path: "../x" }))[0]).toMatch(/\.\./);
    scheduler.sync(fileFlow("a", { path: "../x" }));
    expect(watchers).toEqual([]);
    expect(logs.join("\n")).toMatch(/not activated/);

    const plain = setup();
    plain.scheduler.sync(fileFlow("b"));
    expect(plain.logs.join("\n")).toMatch(/needs a file watcher/);
  });

  it("the event stream hits the limit: extras are skipped, the rest are executed", async () => {
    const releases: (() => void)[] = [];
    const base = setup();
    const watchers: ((p: Json) => void)[] = [];
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent) => {
        await new Promise<void>((r) => releases.push(r));
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      maxConcurrentHookRuns: 2,
      watchFiles: (_s, onChange) => (watchers.push(onChange), () => {}),
    });
    scheduler.sync(fileFlow("a"));
    for (let i = 0; i < 5; i++) watchers[0]!({ event: "add", path: `f${i}`, name: `f${i}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    expect(base.logs.filter((l) => /too many concurrent/.test(l))).toHaveLength(3);
    releases.forEach((r) => r());
  });
});

describe("Scheduler: Telegram Trigger", () => {
  const TG_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const tgFlow = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("tg", "telegram_trigger", { token: TG_TOKEN, ...params })], status);

  function tgSetup(limit = 2) {
    const subs: { spec: import("@fl0w/blocks").TelegramSpec; emit: (u: Json) => void; stopped: boolean }[] = [];
    const base = setup();
    const releases: (() => void)[] = [];
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent, o) => {
        base.calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
        if (hold) await new Promise<void>((r) => releases.push(r));
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      maxConcurrentHookRuns: limit,
      pollTelegram: (spec, emit) => {
        const s = { spec, emit, stopped: false };
        subs.push(s);
        return () => void (s.stopped = true);
      },
    });
    let hold = false;
    return { ...base, scheduler, subs, releases, hold: (v: boolean) => (hold = v) };
  }
  const upd = (n: number): Json => ({ update_id: n, message: { message_id: n, chat: { id: 1 }, text: `m${n}` } });

  it("publishing subscribes the bot; an update starts the flow with the update data", async () => {
    const { scheduler, subs, calls } = tgSetup();
    scheduler.sync(tgFlow("a", { updates: ["message", "callback_query"], chatIds: "12, -100", userIds: "5", dropPending: true }));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.spec).toEqual({ token: TG_TOKEN, updates: ["message", "callback_query"], mode: "polling", chatIds: ["12", "-100"], userIds: ["5"], dropPending: true });
    subs[0]!.emit(upd(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ flowId: "a", trigger: "tg", triggerData: upd(1) }]);
    expect(scheduler.isScheduled("a")).toBe(true);
  });

  it("the token does not get into the log (only the bot id)", () => {
    const { scheduler, logs } = tgSetup();
    scheduler.sync(tgFlow("a"));
    const text = logs.join("\n");
    expect(text).toContain("Telegram bot 123456");
    expect(text).not.toContain(TG_TOKEN);
    expect(text).not.toContain("ABC-DEF");
  });

  it("unpublishing, republishing and stop unsubscribe the bot", () => {
    const { scheduler, subs } = tgSetup();
    scheduler.sync(tgFlow("a"));
    scheduler.sync(tgFlow("a", { updates: ["callback_query"] }));
    expect(subs.map((s) => s.stopped)).toEqual([true, false]);
    scheduler.sync(tgFlow("a", {}, "draft"));
    expect(subs.map((s) => s.stopped)).toEqual([true, true]);
    scheduler.sync(tgFlow("b"));
    scheduler.stop();
    expect(subs.every((s) => s.stopped)).toBe(true);
  });

  it("when slots run out, updates are NOT lost: they wait in the queue and go in order", async () => {
    const { scheduler, subs, calls, releases, hold } = tgSetup(2);
    hold(true);
    scheduler.sync(tgFlow("a"));
    for (let i = 1; i <= 5; i++) subs[0]!.emit(upd(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2); // two slots are occupied, three wait
    releases.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(4);
    releases.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => (c.triggerData as { update_id: number }).update_id)).toEqual([1, 2, 3, 4, 5]);
    releases.splice(0).forEach((r) => r());
  });

  it("unpublishing a flow drops its pending updates", async () => {
    const { scheduler, subs, calls, releases, hold } = tgSetup(1);
    hold(true);
    scheduler.sync(tgFlow("a"));
    for (let i = 1; i <= 3; i++) subs[0]!.emit(upd(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    scheduler.sync(tgFlow("a", {}, "draft"));
    releases.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // 2 and 3 did not start
  });

  it("queue overflow (500) drops the extra and writes to the log", async () => {
    const { scheduler, subs, calls, releases, hold, logs } = tgSetup(1);
    hold(true);
    scheduler.sync(tgFlow("a"));
    for (let i = 1; i <= 505; i++) subs[0]!.emit(upd(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(logs.filter((l) => /event queue is full/.test(l))).toHaveLength(4); // 1 running + 500 in the queue, the other 4 dropped
    scheduler.sync(tgFlow("a", {}, "draft"));
    releases.splice(0).forEach((r) => r());
  });

  it("problems(): secret not set, bad token, unknown type, bad ids", () => {
    const { scheduler } = tgSetup();
    delete process.env["FL0W_SECRET_TELEGRAM_BOT_TOKEN"];
    expect(scheduler.problems(tgFlow("a", { token: "" }))[0]).toMatch(/FL0W_SECRET_TELEGRAM_BOT_TOKEN is not set on the server/);
    expect(scheduler.problems(tgFlow("a", { token: "env:PATH" }))[0]).toMatch(/Only server variables named FL0W_SECRET_/);
    expect(scheduler.problems(tgFlow("a", { token: "garbage" }))[0]).toMatch(/invalid format/);
    expect(scheduler.problems(tgFlow("a", { updates: ["messages"] }))[0]).toMatch(/unknown update type "messages"/);
    expect(scheduler.problems(tgFlow("a", { updates: [] }))[0]).toMatch(/at least one update type/);
    expect(scheduler.problems(tgFlow("a", { chatIds: "abc" }))[0]).toMatch(/not a valid chat id/);
    expect(scheduler.problems(tgFlow("a", { userIds: "@name" }))[0]).toMatch(/not a valid user id/);
    expect(scheduler.problems(tgFlow("a", { chatIds: "@mychannel, -100123", userIds: "42", updates: ["*"] }))).toEqual([]);
    expect(scheduler.problems(tgFlow("a"))).toEqual([]);
  });

  it("a token from an environment variable is resolved on subscribe; without a poller, a log entry", () => {
    process.env["FL0W_SECRET_TG_TEST"] = "999999:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11";
    try {
      const { scheduler, subs } = tgSetup();
      scheduler.sync(tgFlow("a", { token: "env:FL0W_SECRET_TG_TEST" }));
      expect(subs[0]!.spec.token).toBe("999999:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11");
      const plain = setup();
      plain.scheduler.sync(tgFlow("b"));
      expect(plain.logs.join("\n")).toMatch(/needs a Telegram poller/);
    } finally {
      delete process.env["FL0W_SECRET_TG_TEST"];
    }
  });
});

describe("Scheduler: Mail Trigger", () => {
  const mailFlow = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("mt", "mail_trigger", { provider: "imap", host: "imap.test", username: "me@x.io", password: "mail-pw-123", ...params })], status);

  function mailSetup() {
    const subs: { spec: import("@fl0w/blocks").MailWatchSpec; emit: (m: Json) => void; stopped: boolean }[] = [];
    const base = setup();
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent, o) => {
        base.calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      pollMail: (spec, emit) => {
        const s = { spec, emit, stopped: false };
        subs.push(s);
        return () => void (s.stopped = true);
      },
    });
    return { ...base, scheduler, subs };
  }

  it("publishing starts mailbox polling; a message starts the flow with the message data", async () => {
    const { scheduler, subs, calls } = mailSetup();
    scheduler.sync(mailFlow("a", { folder: "Work", intervalSec: 30, action: "none", fromFilter: "boss@x.io" }));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.spec).toMatchObject({ username: "me@x.io", password: "mail-pw-123", folder: "Work", intervalSec: 30, action: "none", fromFilter: "boss@x.io", unreadOnly: true });
    subs[0]!.emit({ id: "7", subject: "Привет" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ flowId: "a", trigger: "mt", triggerData: { id: "7", subject: "Привет" } }]);
  });

  it("the password does not get into the log", () => {
    const { scheduler, logs } = mailSetup();
    scheduler.sync(mailFlow("a"));
    expect(logs.join("\n")).toContain("polls mailbox imap:me@x.io");
    expect(logs.join("\n")).not.toContain("mail-pw-123");
  });

  it("unpublishing, disabling the trigger and stop end polling", () => {
    const { scheduler, subs } = mailSetup();
    scheduler.sync(mailFlow("a"));
    scheduler.sync(mailFlow("a", {}, "draft"));
    expect(subs[0]!.stopped).toBe(true);
    scheduler.sync(withNodes("b", [{ ...node("mt", "mail_trigger", { provider: "imap", host: "h", username: "u@x.io", password: "pw-12345" }), disabled: true }], "published"));
    expect(subs).toHaveLength(1); // the disabled trigger does not poll
    scheduler.sync(mailFlow("c"));
    scheduler.stop();
    expect(subs.every((s) => s.stopped)).toBe(true);
  });

  it("invalid parameters (frequency below 15 s, no host) are visible on publish", () => {
    const { scheduler } = mailSetup();
    expect(scheduler.problems(mailFlow("a", { intervalSec: 5 })).join(" ")).toMatch(/intervalSec/);
    expect(scheduler.problems(mailFlow("a", { host: "" })).join(" ")).toMatch(/host/);
    expect(scheduler.problems(mailFlow("a", { password: "env:PATH" })).join(" ")).toMatch(/FL0W_SECRET_/);
    expect(scheduler.problems(mailFlow("a"))).toEqual([]);
  });
});

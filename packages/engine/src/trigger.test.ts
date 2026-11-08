import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";
import { runFlowInProcess, processSchedulerRun } from "./spawn";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { FlowStore } from "./store";
import { registry } from "@fl0w/blocks";
import type { Flow, Json, WatchMessage } from "@fl0w/schema";
import type { RunnerEvent } from "@fl0w/schema";

const twoTriggers = flow(
  [
    node("a", "every", { interval: 1, unit: "seconds" }),
    node("b", "every", { interval: 2, unit: "minutes" }),
    node("ra", "result"),
    node("rb", "result"),
  ],
  [edge("a", "ra"), edge("b", "rb")],
);

describe("run from a trigger", () => {
  it("manual run (without trigger): all triggers fire", async () => {
    const { started, done } = await collect(twoTriggers);
    expect(started).toEqual(["a", "b", "ra", "rb"]);
    expect(Object.keys(done?.result as object).sort()).toEqual(["ra", "rb"]);
  });

  it("with trigger: only the chosen one starts, the second stays silent", async () => {
    const { started, done } = await collect(twoTriggers, { trigger: "b" });
    expect(started).toEqual(["b", "rb"]);
    const result = done?.result as { triggeredAt: string };
    expect(new Date(result.triggeredAt).toString()).not.toBe("Invalid Date");
  });

  it("trigger points to a nonexistent or non-trigger node → error before the run", async () => {
    for (const trigger of ["ghost", "ra"]) {
      const { events, done } = await collect(twoTriggers, { trigger });
      expect(events).toHaveLength(1);
      expect(done?.error).toBe(`Unknown trigger "${trigger}"`);
    }
  });

  it("Every returns the firing timestamp", async () => {
    const { events } = await collect(flow([node("a", "every")], []));
    const done = events.find((e) => e.event === "node:done");
    expect(done).toMatchObject({ nodeId: "a", output: { out0: { triggeredAt: expect.any(String) } } });
  });
});

describe("run from a trigger in a separate process", () => {
  const run = async (opts: { trigger?: string }) => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(twoTriggers, (e) => events.push(e), { timeoutMs: 20000, ...opts });
    return events;
  };

  it("trigger reaches the runner via IPC", async () => {
    const events = await run({ trigger: "a" });
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).toEqual(["a", "ra"]);
  });

  it("without trigger: like a manual run", async () => {
    const events = await run({});
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).toEqual(["a", "b", "ra", "rb"]);
  });
});

describe("trigger data (webhook) reaches the node through the process", () => {
  const hook: Flow = {
    ...flow(
      [
        node("w", "webhook", { path: "orders", method: "POST" }),
        node("pick", "set", { fields: { who: "{{ body.customer }}", qty: "{{ body.qty }}", q: "{{ query.a }}" }, keepOnlySet: true }),
        node("res", "result"),
      ],
      [edge("w", "pick"), edge("pick", "res")],
    ),
    id: "flow_hook",
    status: "published",
  };
  const payload: Json = { method: "POST", path: "orders", query: { a: "1" }, headers: {}, body: { customer: "ann", qty: 3 } };

  it("runFlowInProcess: triggerData lands in the trigger node's ctx.triggerData", async () => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(hook, (e) => void events.push(e), { trigger: "w", triggerData: payload, timeoutMs: 20000 });
    expect(events.at(-1)).toEqual({ event: "flow:done", result: { who: "ann", qty: 3, q: "1" } });
  });

  it("a manual run does not start a trigger that waits for an event: no made-up data", async () => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(hook, (e) => void events.push(e), { timeoutMs: 20000 });
    expect(events.some((e) => e.event === "node:start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "flow:done", error: expect.stringMatching(/Nothing to start manually/) });
  });

  it("Scheduler + processSchedulerRun: a webhook request goes the whole way to the result", async () => {
    const hub = new RunHub();
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub,
      registry,
      run: processSchedulerRun({ timeoutMs: 20000 }),
    });
    scheduler.sync(hook);
    const found = scheduler.findWebhook("POST", "orders")!;
    const msgs: WatchMessage[] = [];
    hub.subscribe("flow_hook", (m) => void msgs.push(m));
    const seen: RunnerEvent[] = [];
    await scheduler.trigger("flow_hook", found.nodeId, payload, (e) => void seen.push(e));
    expect(seen.at(-1)).toEqual({ event: "flow:done", result: { who: "ann", qty: 3, q: "1" } });
    expect(msgs.some((m) => m.type === "run:event" && m.event.event === "flow:done")).toBe(true);
    scheduler.stop();
  });
});

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

describe("запуск от триггера", () => {
  it("ручной запуск (без trigger): срабатывают все триггеры", async () => {
    const { started, done } = await collect(twoTriggers);
    expect(started).toEqual(["a", "b", "ra", "rb"]);
    expect(Object.keys(done?.result as object).sort()).toEqual(["ra", "rb"]);
  });

  it("с trigger: стартует только выбранный, второй молчит", async () => {
    const { started, done } = await collect(twoTriggers, { trigger: "b" });
    expect(started).toEqual(["b", "rb"]);
    const result = done?.result as { triggeredAt: string };
    expect(new Date(result.triggeredAt).toString()).not.toBe("Invalid Date");
  });

  it("trigger указывает на несуществующую или нетриггерную ноду → ошибка до запуска", async () => {
    for (const trigger of ["ghost", "ra"]) {
      const { events, done } = await collect(twoTriggers, { trigger });
      expect(events).toHaveLength(1);
      expect(done?.error).toBe(`Unknown trigger "${trigger}"`);
    }
  });

  it("Every возвращает метку времени срабатывания", async () => {
    const { events } = await collect(flow([node("a", "every")], []));
    const done = events.find((e) => e.event === "node:done");
    expect(done).toMatchObject({ nodeId: "a", output: { out0: { triggeredAt: expect.any(String) } } });
  });
});

describe("запуск от триггера в отдельном процессе", () => {
  const run = async (opts: { trigger?: string }) => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(twoTriggers, (e) => events.push(e), { timeoutMs: 20000, ...opts });
    return events;
  };

  it("trigger доходит до раннера через IPC", async () => {
    const events = await run({ trigger: "a" });
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).toEqual(["a", "ra"]);
  });

  it("без trigger — как ручной запуск", async () => {
    const events = await run({});
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).toEqual(["a", "b", "ra", "rb"]);
  });
});

describe("данные триггера (вебхук) доходят до ноды через процесс", () => {
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

  it("runFlowInProcess: triggerData попадает в ctx.triggerData триггер-ноды", async () => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(hook, (e) => void events.push(e), { trigger: "w", triggerData: payload, timeoutMs: 20000 });
    expect(events.at(-1)).toEqual({ event: "flow:done", result: { who: "ann", qty: 3, q: "1" } });
  });

  it("ручной запуск не стартует триггер, ждущий события: никаких выдуманных данных", async () => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(hook, (e) => void events.push(e), { timeoutMs: 20000 });
    expect(events.some((e) => e.event === "node:start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: "flow:done", error: expect.stringMatching(/Nothing to start manually/) });
  });

  it("Scheduler + processSchedulerRun: запрос вебхука проходит весь путь до результата", async () => {
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

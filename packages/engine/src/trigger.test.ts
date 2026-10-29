import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";
import { runFlowInProcess } from "./spawn";
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

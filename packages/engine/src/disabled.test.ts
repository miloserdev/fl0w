import { registry } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findIncoming, validateCallChannels } from "./call-channel";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { FlowStore } from "./store";
import { collect, edge, flow, node } from "./test-helpers";
import { validateFlow } from "./validate";

const off = <T extends ReturnType<typeof node>>(n: T): T => ({ ...n, disabled: true });
const run = (f: Flow, extra: Record<string, unknown> = {}) => collect(f, { registry, ...extra });

describe("отключённая нода", () => {
  it("в запуске не участвует: не исполняется, ничего не отдаёт — ветка за ней не идёт, соседние ветки идут", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), off(node("mid", "code", { code: "return { out0: 'MID' }" })), node("after", "noop"), node("r1", "result"), node("side", "noop"), node("r2", "result")],
      [edge("s", "mid"), edge("mid", "after"), edge("after", "r1"), edge("s", "side"), edge("side", "r2")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.started).not.toContain("mid");
    expect(r.started).not.toContain("after");
    expect(r.started).toEqual(expect.arrayContaining(["s", "side", "r2"]));
    expect(r.done?.result).toEqual({ v: 1 }); // единственный Result, до которого данные дошли
  });

  it("Merge any получает вход от остальных веток — отключённый источник просто «не пришёл»", async () => {
    const f = flow(
      [node("a", "source", { json: { a: 1 } }), off(node("b", "source", { json: { b: 2 } })), node("m", "merge", { mode: "array", wait: "any" }), node("r", "result")],
      [edge("a", "m", "out0", "in0", "ea"), edge("b", "m", "out0", "in1", "eb"), edge("m", "r")],
    );
    expect((await run(f)).done?.result).toEqual([{ a: 1 }]);
  });

  it("отключённый триггер не стартует; если отключены все — запуск идёт от источников данных; явный запуск отключённого — ошибка", async () => {
    const f = flow(
      [off(node("m1", "manual")), node("m2", "manual"), node("c1", "code", { code: "return { out0: 1 }" }), node("c2", "code", { code: "return { out0: 2 }" }), node("r1", "result"), node("r2", "result")],
      [edge("m1", "c1"), edge("c1", "r1"), edge("m2", "c2"), edge("c2", "r2")],
    );
    const r = await run(f);
    expect(r.started).toEqual(["m2", "c2", "r2"]);
    expect((await run(f, { trigger: "m1" })).done?.error).toMatch(/Trigger "m1" is disabled/);
    // отключён единственный триггер, источников нет — стартовать нечему, это не «запуск без триггеров»
    const solo = flow([off(node("m", "manual")), node("c", "noop"), node("r", "result")], [edge("m", "c"), edge("c", "r")]);
    expect((await run(solo)).started).toEqual([]);
  });

  it("параметры отключённой ноды не проверяются (её можно оставить недоделанной); у включённой — проверяются", () => {
    const broken = node("h", "http_request", {}); // url обязателен
    expect(validateFlow(flow([broken], []), registry).ok).toBe(false);
    expect(validateFlow(flow([off(broken)], []), registry).ok).toBe(true);
  });

  it("отключённый инструмент и банк памяти недоступны хозяину; отключённый вызов не занимает канал", async () => {
    const f = flow(
      [node("s", "source", { json: { x: 1 } }), node("a", "code_agent", { code: "return { out0: { tools: tools.list().map((t) => t.name), mem: typeof memory } }" }), off(node("t", "tool_calculator")), node("t2", "tool_datetime"), node("r", "result")],
      [edge("s", "a"), edge("a", "r"), edge("t", "a", "tool", "tools", "et1"), edge("t2", "a", "tool", "tools", "et2")],
    );
    expect((await run(f)).done?.result).toEqual({ tools: ["current_datetime"], mem: "undefined" });
    const a: Flow = { ...flow([node("in", "call_trigger", { channelId: "c" })], []), id: "A" };
    const b: Flow = { ...flow([off(node("in", "call_trigger", { channelId: "c" }))], []), id: "B" };
    expect(validateCallChannels(a, [b])).toEqual([]); // отключённый Collector в другом флоу канал не занимает
    expect(findIncoming([a, b], "c").flow.id).toBe("A");
  });
});

describe("отключённый триггер и планировщик", () => {
  afterEach(() => vi.useRealTimers());

  it("таймер Every и вебхук отключённой ноды не регистрируются; включённые — регистрируются", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: new RunHub(),
      registry,
      run: async (_f, onEvent, o) => {
        calls.push(o.trigger);
        onEvent({ event: "flow:done", result: 1 });
      },
    });
    const f: Flow = {
      ...flow(
        [off(node("ev", "every", { interval: 1, unit: "seconds" })), node("ev2", "every", { interval: 2, unit: "seconds" }), off(node("wh", "webhook", { path: "off-hook", method: "POST" })), node("wh2", "webhook", { path: "on-hook", method: "POST" }), node("r", "result")],
        [],
      ),
      id: "f",
      status: "published",
    };
    scheduler.sync(f);
    expect(scheduler.findWebhook("POST", "off-hook")).toBeUndefined();
    expect(scheduler.findWebhook("POST", "on-hook")).toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["ev2"]); // отключённый Every (1 с) не тикал
    scheduler.stop();
  });
});

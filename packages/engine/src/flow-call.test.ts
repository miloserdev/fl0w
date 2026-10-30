import { registry } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHub } from "./hub";
import { Scheduler, type SchedulerRun } from "./scheduler";
import { runFlowInProcess } from "./spawn";
import { FlowStore } from "./store";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";

/** Опубликованный флоу: триггер `t` (Every, годится для теста: isTrigger) и `r`. */
const pub = (id: string): Flow => ({ ...flow([node("t", "every", { interval: 1, unit: "hours" }), node("r", "result")], [edge("t", "r")]), id, status: "published" });

type Req = { flowId: string; triggerId: string; data: Json };
function setup(run: SchedulerRun, max = 8) {
  const logs: string[] = [];
  const scheduler = new Scheduler({ store: new FlowStore("/nonexistent"), hub: new RunHub(), registry: testRegistry, run, log: (m) => logs.push(m), maxConcurrentHookRuns: max });
  return { scheduler, logs };
}
const idle: SchedulerRun = async (_f, onEvent) => onEvent({ event: "flow:done", result: 1 });

afterEach(() => vi.useRealTimers());

describe("Scheduler.fireFrom (вызов триггера другого флоу)", () => {
  it("запускает триггер опубликованного флоу с данными и не ждёт завершения", async () => {
    const seen: { flow: string; trigger: string; data?: Json }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { scheduler } = setup(async (f, onEvent, o) => {
      seen.push({ flow: f.id, trigger: o.trigger, data: o.triggerData });
      await gate;
      onEvent({ event: "flow:done", result: 1 });
    });
    scheduler.sync(pub("a"));
    scheduler.sync(pub("b"));
    await scheduler.fireFrom(["a"], { flowId: "b", triggerId: "t", data: { hi: 1 } }); // вернулся, хотя b ещё идёт
    expect(seen).toEqual([{ flow: "b", trigger: "t", data: { hi: 1 } }]);
    release();
    scheduler.stop();
  });

  it("отказывает: цель не опубликована, нет такого триггера, не триггер", async () => {
    const { scheduler } = setup(idle);
    scheduler.sync(pub("a"));
    await expect(scheduler.fireFrom(["a"], { flowId: "zzz", triggerId: "t", data: null })).rejects.toThrow(/not published/);
    scheduler.sync(pub("b"));
    await expect(scheduler.fireFrom(["a"], { flowId: "b", triggerId: "nope", data: null })).rejects.toThrow(/no trigger "nope"/);
    await expect(scheduler.fireFrom(["a"], { flowId: "b", triggerId: "r", data: null })).rejects.toThrow(/no trigger "r"/);
    scheduler.stop();
  });

  it("рекурсия: флоу из цепочки (и сам себя) вызвать нельзя; глубина ограничена", async () => {
    const { scheduler } = setup(idle);
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) scheduler.sync(pub(id));
    await expect(scheduler.fireFrom(["a"], { flowId: "a", triggerId: "t", data: null })).rejects.toThrow(/Recursive call.*a → a/);
    await expect(scheduler.fireFrom(["a", "b"], { flowId: "a", triggerId: "t", data: null })).rejects.toThrow(/a → b → a/);
    await expect(scheduler.fireFrom(["a", "b", "c", "d", "e"], { flowId: "f", triggerId: "t", data: null })).rejects.toThrow(/too deep/);
    await expect(scheduler.fireFrom(["a", "b", "c", "d"], { flowId: "e", triggerId: "t", data: null })).resolves.toBeUndefined();
    scheduler.stop();
  });

  it("allowRecursive разрешает вызов флоу из цепочки (в том числе самого себя), но глубину ограничивает maxDepth", async () => {
    const { scheduler, logs } = setup(idle);
    scheduler.sync(pub("a"));
    scheduler.sync(pub("b"));
    const self = { flowId: "a", triggerId: "t", data: null, allowRecursive: true };
    await expect(scheduler.fireFrom(["a"], self)).resolves.toBeUndefined();
    await expect(scheduler.fireFrom(["a", "b", "a"], { ...self, flowId: "b" })).resolves.toBeUndefined();
    // по умолчанию глубина 5; своя — через maxDepth, но не выше жёсткого потолка 20
    await expect(scheduler.fireFrom(["a", "a", "a", "a", "a"], self)).rejects.toThrow(/too deep \(limit 5/);
    await expect(scheduler.fireFrom(["a", "a", "a"], { ...self, maxDepth: 3 })).rejects.toThrow(/limit 3/);
    await expect(scheduler.fireFrom(Array(10).fill("a"), { ...self, maxDepth: 12 })).resolves.toBeUndefined();
    await expect(scheduler.fireFrom(Array(20).fill("a"), { ...self, maxDepth: 20 })).rejects.toThrow(/limit 20/);
    await expect(scheduler.fireFrom(Array(25).fill("a"), { ...self, maxDepth: 99 })).rejects.toThrow(/limit 20/);
    // maxDepth 0 — без ограничения (и сверх потолка 20), в логе предупреждение
    await expect(scheduler.fireFrom(Array(100).fill("a"), { ...self, maxDepth: 0 })).resolves.toBeUndefined();
    expect(logs.some((l) => /unlimited/.test(l))).toBe(true);
    scheduler.stop();
  });

  it("занятый планировщик (лимит параллельных запусков) — отказ с понятным текстом", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { scheduler } = setup(async (_f, onEvent) => {
      await gate;
      onEvent({ event: "flow:done", result: 1 });
    }, 1);
    scheduler.sync(pub("a"));
    scheduler.sync(pub("b"));
    await scheduler.fireFrom(["a"], { flowId: "b", triggerId: "t", data: null });
    await expect(scheduler.fireFrom(["a"], { flowId: "b", triggerId: "t", data: null })).rejects.toThrow(/busy/);
    release();
    scheduler.stop();
  });

  it("цепочка A → B → A: запуск B получает цепочку и вторая попытка вернуться в A отклоняется", async () => {
    const results: string[] = [];
    const run: SchedulerRun = async (f, onEvent, o) => {
      if (f.id === "a") await o.onFire!({ flowId: "b", triggerId: "t", data: 1 }).then(() => results.push("a→b ok"));
      if (f.id === "b") await o.onFire!({ flowId: "a", triggerId: "t", data: 2 }).then(() => results.push("b→a ok"), (e: Error) => results.push(`b→a: ${e.message}`));
      onEvent({ event: "flow:done", result: 1 });
    };
    const { scheduler } = setup(run);
    scheduler.sync(pub("a"));
    scheduler.sync(pub("b"));
    await scheduler.trigger("a", "t", null);
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toContain("a→b ok");
    expect(results.some((r) => /^b→a: Recursive call.*a → b → a/.test(r))).toBe(true);
    scheduler.stop();
  });
});

describe("блок Run Flow в настоящем процессе-раннере", () => {
  const f = (flowId: string, data?: Json) =>
    flow([node("s", "source", { json: { v: 1 } }), node("c", "run_flow", { flowId, triggerId: "t", ...(data !== undefined ? { data } : {}) }), node("r", "result")], [edge("s", "c"), edge("c", "r")]);
  const run = async (fl: Flow, onFire?: (r: Req) => Promise<void>) => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(fl, (e) => events.push(e), { timeoutMs: 20000, onFire });
    const done = events.at(-1);
    return { events, done: done?.event === "flow:done" ? done : undefined };
  };

  it("по умолчанию отдаёт весь вход; ответ хозяина превращается в успех", async () => {
    const reqs: Req[] = [];
    const r = await run(f("other"), async (q) => void reqs.push(q));
    expect(reqs).toEqual([{ flowId: "other", triggerId: "t", data: { v: 1 }, allowRecursive: false, maxDepth: 5 }]);
    expect(r.done?.result).toEqual({ fired: true, flowId: "other", triggerId: "t" });
  });

  it("data из параметров (в том числе с выражением) заменяет вход", async () => {
    const reqs: Req[] = [];
    await run(f("other", { picked: "{{ inputs.in0.v }}" }), async (q) => void reqs.push(q));
    expect(reqs[0]!.data).toEqual({ picked: 1 });
  });

  it("allowRecursive и maxDepth из параметров блока доходят до хозяина", async () => {
    const reqs: (Req & { allowRecursive?: boolean; maxDepth?: number })[] = [];
    const fl = flow(
      [node("s", "source", { json: { v: 1 } }), node("c", "run_flow", { flowId: "x", triggerId: "t", allowRecursive: true, maxDepth: 7 }), node("r", "result")],
      [edge("s", "c"), edge("c", "r")],
    );
    await run(fl, async (q) => void reqs.push(q));
    expect(reqs[0]).toMatchObject({ flowId: "x", allowRecursive: true, maxDepth: 7 });
    const plain = await (async () => {
      const got: Record<string, unknown>[] = [];
      await run(f("x"), async (q) => void got.push(q));
      return got[0]!;
    })();
    expect(plain["allowRecursive"]).toBe(false); // по умолчанию рекурсия запрещена
  });

  it("отказ хозяина (рекурсия, не опубликован…) — ошибка ноды с его текстом", async () => {
    const r = await run(f("other"), async () => {
      throw new Error("Flow \"other\" is not published");
    });
    expect(r.done?.error).toMatch(/Node "c" failed: Flow "other" is not published/);
  });

  it("без onFire (например, окружение без сервера) — понятная ошибка, а не зависание", async () => {
    const r = await run(f("other"));
    expect(r.done?.error).toMatch(/not available/);
  });
});

describe("блоки вызова (в памяти)", () => {
  it("run_flow требует оба id и ctx.fire", async () => {
    const empty = flow([node("s", "source", { json: { v: 1 } }), node("c", "run_flow", { flowId: "", triggerId: "t" }), node("r", "result")], [edge("s", "c"), edge("c", "r")]);
    expect((await collect(empty, { registry })).done?.error).toMatch(/required/);
    const ok = flow([node("s", "source", { json: { v: 1 } }), node("c", "run_flow", { flowId: "x", triggerId: "t" }), node("r", "result")], [edge("s", "c"), edge("c", "r")]);
    expect((await collect(ok, { registry })).done?.error).toMatch(/not available/);
    const fired: Req[] = [];
    const r = await collect(ok, { registry, fire: async (q) => void fired.push(q) });
    expect(fired).toHaveLength(1);
    expect(r.done?.result).toEqual({ fired: true, flowId: "x", triggerId: "t" });
  });

  it("call_trigger — триггер события: ручной запуск его не стартует, с закреплёнными данными — стартует, по событию отдаёт данные вызова", async () => {
    const f = flow([node("c", "call_trigger"), node("r", "result")], [edge("c", "r")]);
    expect((await collect(f, { registry })).done?.error).toMatch(/Nothing to start manually/);
    const pinned = flow([{ ...node("c", "call_trigger"), pinData: { out0: { x: 1 } } }, node("r", "result")], [edge("c", "r")]);
    expect((await collect(pinned, { registry })).done?.result).toEqual({ x: 1 });
    expect((await collect(f, { registry, trigger: "c", triggerData: { from: "a", data: 5 } })).done?.result).toEqual({ from: "a", data: 5 });
  });
});

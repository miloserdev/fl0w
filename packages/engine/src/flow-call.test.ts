import { registry } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHub } from "./hub";
import { Scheduler, type SchedulerRun } from "./scheduler";
import { runFlowInProcess, sandboxEnv } from "./spawn";
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

describe("Scheduler.fireFrom: песочница («Запустить» в редакторе) не пересекается с рабочими запусками", () => {
  /** Локальный (НЕ опубликованный) флоу: Manual → Result и триггер вызова `c`. */
  const localFlow = (id = "draft"): Flow => ({ ...flow([node("m", "manual"), node("c", "call_trigger"), node("r", "result")], [edge("m", "r"), edge("c", "r", "out0", "in0", "e2")]), id });
  const sandbox = (over: Partial<import("./scheduler").LocalFlow> = {}) => ({ flow: localFlow(), ...over });

  it("вызов триггера своего флоу не требует публикации; события вложенного запуска идут вызывающему, запуск дожидается", async () => {
    const got: string[] = [];
    const calls: { flow: string; trigger: string; data?: Json; sandbox?: boolean }[] = [];
    const { scheduler } = setup(async (f, onEvent, o) => {
      calls.push({ flow: f.id, trigger: o.trigger, data: o.triggerData, sandbox: o.sandbox });
      onEvent({ event: "node:start", nodeId: o.trigger });
      await new Promise((r) => setTimeout(r, 15));
      onEvent({ event: "flow:done", result: 1 });
    });
    await scheduler.fireFrom(["draft"], { flowId: "draft", triggerId: "c", data: { x: 1 }, allowRecursive: true }, sandbox({ onEvent: (e) => got.push(e.event) }));
    expect(calls).toEqual([{ flow: "draft", trigger: "c", data: { x: 1 }, sandbox: true }]);
    expect(got).toEqual(["node:start", "flow:done"]);
    scheduler.stop();
  });

  it("другой флоу в песочнице — его СОХРАНЁННАЯ копия (черновик подходит), опубликованная рабочая не запускается", async () => {
    const calls: { flow: string; sandbox?: boolean }[] = [];
    const { scheduler } = setup(async (f, onEvent, o) => {
      calls.push({ flow: f.id, sandbox: o.sandbox });
      onEvent({ event: "flow:done", result: 1 });
    });
    // рабочая (опубликованная) копия того же флоу есть — но песочница обязана взять сохранённую и не трогать рабочую
    scheduler.sync(pub("other"));
    const draftCopy: Flow = { ...localFlow("other"), status: "draft" };
    await scheduler.fireFrom(["draft"], { flowId: "other", triggerId: "c", data: null }, sandbox({ resolve: async (id) => (id === "other" ? draftCopy : null) }));
    expect(calls).toEqual([{ flow: "other", sandbox: true }]);
    scheduler.stop();
  });

  it("рабочий флоу не видит пробных запусков: хаб (Watch) пуст, Error Trigger не получает ошибок, лимит вебхуков не тратится", async () => {
    const hub = new RunHub();
    const handled: string[] = [];
    const run: SchedulerRun = async (f, onEvent) => {
      if (f.id === "handler") handled.push("handler ran");
      else onEvent({ event: "flow:done", error: "boom" });
    };
    const scheduler = new Scheduler({ store: new FlowStore("/nonexistent"), hub, registry: testRegistry, run, maxConcurrentHookRuns: 1 });
    scheduler.sync({ ...flow([node("et", "error_trigger"), node("r", "result")], [edge("et", "r")]), id: "handler", status: "published" } as Flow);
    const seen: string[] = [];
    hub.subscribe("draft", (m) => seen.push(m.type));
    await scheduler.fireFrom(["draft"], { flowId: "draft", triggerId: "c", data: null, allowRecursive: true }, sandbox());
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
    expect(hub.lastRun("draft")).toBeUndefined();
    expect(handled).toEqual([]);
    scheduler.stop();
  });

  it("правила рекурсии и глубины те же: вызов себя без allowRecursive запрещён", async () => {
    const { scheduler } = setup(idle);
    await expect(scheduler.fireFrom(["draft"], { flowId: "draft", triggerId: "c", data: null }, sandbox())).rejects.toThrow(/Recursive call/);
    await expect(scheduler.fireFrom(["draft"], { flowId: "draft", triggerId: "c", data: null, allowRecursive: true, maxDepth: 1 }, sandbox())).rejects.toThrow(/too deep/);
    scheduler.stop();
  });

  it("нет такого триггера или флоу не сохранён — понятные ошибки (про публикацию в песочнице речи нет)", async () => {
    const { scheduler } = setup(idle);
    await expect(scheduler.fireFrom(["draft"], { flowId: "draft", triggerId: "zzz", data: null, allowRecursive: true }, sandbox())).rejects.toThrow(/no trigger "zzz"/);
    const e = await scheduler.fireFrom(["draft"], { flowId: "nope", triggerId: "c", data: null }, sandbox()).catch((x: Error) => x.message);
    expect(e).toMatch(/not saved on the server/);
    expect(e).not.toMatch(/not published/);
    scheduler.stop();
  });

  it("в песочнице maxDepth 0 («без ограничения») не действует: вложенные запуски дожидаются и держат процессы — потолок 20", async () => {
    const { scheduler, logs } = setup(idle);
    const call = { flowId: "draft", triggerId: "c", data: null, allowRecursive: true, maxDepth: 0 };
    await expect(scheduler.fireFrom(Array(19).fill("draft"), call, sandbox())).resolves.toBeUndefined();
    await expect(scheduler.fireFrom(Array(20).fill("draft"), call, sandbox())).rejects.toThrow(/too deep \(limit 20 flows\)\. The sandbox/);
    expect(logs.some((l) => /unlimited/.test(l))).toBe(false);
    scheduler.stop();
  });

  it("отмена ленты (signal) доходит до вложенных запусков и не даёт стартовать новым", async () => {
    const ac = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const { scheduler } = setup(async (_f, onEvent, o) => {
      signals.push(o.signal);
      onEvent({ event: "flow:done", result: 1 });
    });
    const call = { flowId: "draft", triggerId: "c", data: null, allowRecursive: true };
    await scheduler.fireFrom(["draft"], call, sandbox({ signal: ac.signal }));
    expect(signals).toEqual([ac.signal]);
    ac.abort();
    await expect(scheduler.fireFrom(["draft"], call, sandbox({ signal: ac.signal }))).rejects.toThrow(/Aborted/);
    expect(signals).toHaveLength(1); // новый запуск не стартовал
    scheduler.stop();
  });

  it("вложенный вызов остаётся в песочнице (цепочка продолжается без публикации)", async () => {
    const depth: number[] = [];
    const flags: (boolean | undefined)[] = [];
    let level = 0;
    const run: SchedulerRun = async (_f, onEvent, o) => {
      depth.push(++level);
      flags.push(o.sandbox);
      if (level < 3) await o.onFire!({ flowId: "draft", triggerId: "c", data: level, allowRecursive: true, maxDepth: 10 });
      onEvent({ event: "flow:done", result: 1 });
    };
    const { scheduler } = setup(run);
    await scheduler.fireFrom(["draft"], { flowId: "draft", triggerId: "c", data: 0, allowRecursive: true, maxDepth: 10 }, sandbox());
    expect(depth).toEqual([1, 2, 3]);
    expect(flags).toEqual([true, true, true]);
    scheduler.stop();
  });
});

describe("окружение песочницы", () => {
  it("банки памяти песочницы — вложенный каталог _sandbox; без памяти окружение не меняется", () => {
    expect(sandboxEnv({ FL0W_MEMORY_DIR: "/data/memory" })["FL0W_MEMORY_DIR"]).toBe("/data/memory/_sandbox");
    expect(sandboxEnv({ FL0W_MEMORY_DIR: "/data/memory/" })["FL0W_MEMORY_DIR"]).toBe("/data/memory/_sandbox");
    expect(sandboxEnv({ OTHER: "1" })).toEqual({ OTHER: "1" });
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

describe("песочница: память отдельная от рабочей (настоящий процесс-раннер)", () => {
  it("sandbox:true пишет банк в <память>/_sandbox, рабочий каталог не трогает", async () => {
    const { mkdtempSync, existsSync, rmSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "fl0w-sbx-"));
    const saved = process.env["FL0W_MEMORY_DIR"];
    process.env["FL0W_MEMORY_DIR"] = dir;
    try {
      const f = flow(
        [node("s", "source", { json: { v: 1 } }), node("a", "code_agent", { code: 'await memory.set("k", 1); return { out0: { ok: true } }' }), node("m", "memory_bank", { name: "bank" }), node("r", "result")],
        [edge("s", "a"), edge("a", "r"), edge("m", "a", "memory", "memory")],
      );
      const run = async (sandbox: boolean) => {
        const events: RunnerEvent[] = [];
        await runFlowInProcess(f, (e) => events.push(e), { timeoutMs: 20000, sandbox });
        expect(events.at(-1)).toMatchObject({ event: "flow:done", result: { ok: true } });
      };
      await run(true);
      expect(existsSync(path.join(dir, "bank.json"))).toBe(false); // рабочая память не тронута
      expect(existsSync(path.join(dir, "_sandbox", "bank.json"))).toBe(true);
      await run(false);
      expect(readdirSync(dir).sort()).toEqual(["_sandbox", "bank.json"]); // обычный запуск пишет в рабочую
    } finally {
      if (saved === undefined) delete process.env["FL0W_MEMORY_DIR"];
      else process.env["FL0W_MEMORY_DIR"] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

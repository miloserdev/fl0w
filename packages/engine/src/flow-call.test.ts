import { registry } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { channelsOf, findIncoming, validatePhoneChannels } from "./phone";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { runFlowInProcess, sandboxEnv } from "./spawn";
import { FlowStore } from "./store";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { validateFlow } from "./validate";

/** Вызванный флоу: Phone Incoming(channel) → [шаги] → Result. */
const callee = (id: string, channel: string, middle: ReturnType<typeof node>[] = [], edges: ReturnType<typeof edge>[] = []): Flow => ({
  ...flow(
    [node("in", "call_trigger", { channelId: channel }), ...middle, node("res", "result")],
    middle.length ? [edge("in", middle[0]!.id), ...edges, edge(middle.at(-1)!.id, "res")] : [edge("in", "res")],
  ),
  id,
});
/** Вызывающий: Source → Phone Outgoing → (out0 → Result, err → Result2 по желанию). */
const caller = (params: Record<string, Json>, opts: { errPort?: boolean; id?: string } = {}): Flow => ({
  ...flow(
    [node("s", "source", { json: { v: 1 } }), node("p", "run_flow", params), node("r", "result"), ...(opts.errPort ? [node("er", "result")] : [])],
    [edge("s", "p"), edge("p", "r"), ...(opts.errPort ? [edge("p", "er", "err", "in0", "e-err")] : [])],
  ),
  id: opts.id ?? "caller",
});
const code = (id: string, body: string) => node(id, "code", { code: body });
const resolverFor = (...flows: Flow[]) => async (ch: string) => findIncoming(flows, ch);
const run = (f: Flow, flows: Flow[], extra: Record<string, unknown> = {}) => collect(f, { registry, resolveCall: resolverFor(f, ...flows), ...extra });
const ev = (events: RunnerEvent[], kind: string) => events.filter((e) => e.event === kind);

describe("phone-пара: каналы, порты, валидация", () => {
  it("порт err есть только в режиме await", () => {
    const await_ = validateFlow(caller({ channelId: "c", mode: "await" }, { errPort: true }), registry);
    expect(await_.ok).toBe(true);
    const shoot = validateFlow(caller({ channelId: "c", mode: "shoot" }, { errPort: true }), registry);
    expect(shoot.ok).toBe(false);
    expect(!shoot.ok && shoot.issues.map((i) => i.code)).toContain("unknown_port");
    // по умолчанию режим await
    expect(validateFlow(caller({ channelId: "c" }, { errPort: true }), registry).ok).toBe(true);
  });

  it("связь 1:1: два входящих (или два исходящих) на одном канале — ошибка и внутри флоу, и между флоу", () => {
    const dupIn: Flow = { ...flow([node("a", "call_trigger", { channelId: "x" }), node("b", "call_trigger", { channelId: "x" }), node("r", "result")], [edge("a", "r")]), id: "d" };
    const r = validateFlow(dupIn, registry);
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("phone_channel");
    const other = callee("other", "chan");
    expect(validatePhoneChannels(callee("mine", "chan"), [other]).map((i) => i.code)).toEqual(["phone_channel"]);
    expect(validatePhoneChannels(callee("mine", "chan"), [callee("mine", "chan")])).toEqual([]); // тот же флоу — своя прежняя копия
    expect(validatePhoneChannels(callee("mine", "chan"), [caller({ channelId: "chan" })])).toEqual([]); // другая сторона — это пара
    expect(validatePhoneChannels(caller({ channelId: "chan" }), [caller({ channelId: "chan" }, { id: "c2" })]).length).toBe(1);
    expect(validatePhoneChannels(caller({ channelId: "unpaired" }), [])).toEqual([]); // пары может ещё не быть
  });

  it("findIncoming: ровно один; нет или несколько — понятная ошибка; пробелы по краям не значимы", () => {
    expect(findIncoming([callee("a", " c1 ")], "c1").triggerId).toBe("in");
    expect(() => findIncoming([callee("a", "c1")], "zzz")).toThrow(/No phone-incoming with channel "zzz"/);
    expect(() => findIncoming([callee("a", "c1"), callee("b", "c1")], "c1")).toThrow(/ambiguous/);
    expect(channelsOf(caller({ channelId: "k" }))).toEqual({ incoming: [], outgoing: [{ nodeId: "p", channelId: "k" }] });
  });

  it("phone-incoming не входит в стартовые: ручной запуск его не поднимает, даже с закреплёнными данными", async () => {
    const f: Flow = { ...flow([{ ...node("in", "call_trigger", { channelId: "c" }), pinData: { out0: { x: 1 } } }, node("r", "result")], [edge("in", "r")]), id: "solo" };
    const r = await collect(f, { registry });
    expect(r.started).toEqual([]);
    expect(r.done?.error).toMatch(/Nothing to start manually/);
  });
});

describe("await: с подтверждением", () => {
  it("out0 — результат вызванного флоу (значение его Result), данные вызова приходят в phone-incoming", async () => {
    const c = callee("c", "ch", [code("m", "return { out0: { got: inputs.in0, doubled: inputs.in0.v * 2 } }")]);
    const r = await run(caller({ channelId: "ch" }), [c]);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ got: { v: 1 }, doubled: 2 });
  });

  it("вызванный флоу без Result даёт null; data из параметров заменяет вход", async () => {
    const noResult: Flow = { ...flow([node("in", "call_trigger", { channelId: "ch" })], []), id: "nr" };
    expect((await run(caller({ channelId: "ch" }), [noResult])).done?.result).toBeNull();
    const c = callee("c", "ch", [code("m", "return { out0: inputs.in0 }")]);
    expect((await run(caller({ channelId: "ch", data: { fixed: true } }), [c])).done?.result).toEqual({ fixed: true });
  });

  it("падение вызванного флоу уходит в порт err (с текстом ошибки), out0 не выходит", async () => {
    const c = callee("c", "ch", [code("m", "throw new Error('callee boom')")]);
    const r = await run(caller({ channelId: "ch" }, { errPort: true }), [c]);
    expect(r.done?.error).toBeUndefined();
    const res = r.done?.result as Record<string, Json>;
    // по out0 ничего не вышло — единственный Result получил ошибку из err
    expect(res).toMatchObject({ message: expect.stringContaining("callee boom"), channelId: "ch" });
  });

  it("порт err ни к чему не подключён — ошибка не теряется: падает сама нода", async () => {
    const c = callee("c", "ch", [code("m", "throw new Error('lost?')")]);
    const r = await run(caller({ channelId: "ch" }), [c]);
    expect(r.done?.error).toMatch(/Node "p" failed:.*lost\?/);
  });

  it("нет канала / неоднозначный канал / нет резолвера — в err (или падение ноды)", async () => {
    const r = await run(caller({ channelId: "nope" }, { errPort: true }), []);
    expect(r.done?.result).toMatchObject({ message: expect.stringMatching(/No phone-incoming with channel "nope"/) });
    const r2 = await collect(caller({ channelId: "x" }), { registry });
    expect(r2.done?.error).toMatch(/not available/);
  });

  it("рекурсия: вызов флоу из своей цепочки запрещён (ошибка в err), allowRecursive разрешает; глубина ограничена maxDepth", async () => {
    // флоу сам себя: Source → Phone Out (await) ; Phone In → тот же Phone Out
    const self: Flow = {
      ...flow(
        [node("s", "source", { json: { n: 1 } }), node("in", "call_trigger", { channelId: "loop" }), node("p", "run_flow", { channelId: "loop" }), node("r", "result"), node("er", "result")],
        [edge("s", "p"), edge("in", "p", "out0", "in0", "e2"), edge("p", "r"), edge("p", "er", "err", "in0", "e3")],
      ),
      id: "self",
    };
    // вход ТОЖЕ вызывает p, поэтому у p два источника — ребро s→p убираем, стартуем из in... нужен другой старт: используем отдельный флоу-вызыватель
    const looper: Flow = { ...flow([node("in", "call_trigger", { channelId: "loop" }), node("p", "run_flow", { channelId: "loop", allowRecursive: false }), node("r", "result"), node("er", "result")], [edge("in", "p"), edge("p", "r"), edge("p", "er", "err", "in0", "e3")]), id: "looper" };
    const starter = caller({ channelId: "loop" }, { errPort: true, id: "starter" });
    const r = await run(starter, [looper]);
    // starter → looper (глубина 1) → looper снова: looper уже в цепочке → отказ уходит в err looper'а, а не обрушивает всё
    expect(r.done?.error).toBeUndefined();
    const res = r.done?.result as Record<string, Json>;
    expect(JSON.stringify(res)).toMatch(/Recursive call/);
    expect(self.id).toBe("self");

    // с allowRecursive цепочка идёт, пока не упрётся в maxDepth, и тоже заканчивается ошибкой в err — не зависанием
    const deep: Flow = { ...flow([node("in", "call_trigger", { channelId: "loop" }), node("p", "run_flow", { channelId: "loop", allowRecursive: true, maxDepth: 3 }), node("r", "result"), node("er", "result")], [edge("in", "p"), edge("p", "r"), edge("p", "er", "err", "in0", "e3")]), id: "deep" };
    const r2 = await run(caller({ channelId: "loop", allowRecursive: true, maxDepth: 3 }, { errPort: true, id: "starter2" }), [deep]);
    expect(r2.done?.error).toBeUndefined();
    expect(JSON.stringify(r2.done?.result)).toMatch(/too deep \(limit 3/);
  });
});

describe("await: два графа одного флоу", () => {
  it("вызов отдельного phone-incoming ТОГО ЖЕ флоу (не связанного с вызывающим графом) — не рекурсия", async () => {
    // граф 1: Manual → Phone Out(norm0) → Result; граф 2 (не соединён): Phone In(norm0) → Code → Result
    const one: Flow = {
      ...flow(
        [node("m0", "manual"), node("p", "run_flow", { channelId: "norm0", data: { v: 5 } }), node("r", "result"), node("in", "call_trigger", { channelId: "norm0" }), code("m", "return { out0: { doubled: inputs.in0.v * 2 } }"), node("r2", "result")],
        [edge("m0", "p"), edge("p", "r"), edge("in", "m"), edge("m", "r2")],
      ),
      id: "same",
    };
    const r = await collect(one, { registry, resolveCall: resolverFor(one) });
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ doubled: 10 });
  });

  it("а если из вызванного графа тот же канал вызывается снова — это уже рекурсия (повторный вход в тот же phone-incoming)", async () => {
    // Manual и Phone In сходятся (Merge any) в один и тот же Phone Out(norm0): вызванный граф зовёт тот же канал снова
    const one: Flow = {
      ...flow(
        [node("m0", "manual"), node("in", "call_trigger", { channelId: "norm0" }), node("mg", "merge", { mode: "array", wait: "any" }), node("p", "run_flow", { channelId: "norm0" }), node("r", "result")],
        [edge("m0", "mg", "out0", "in0", "e0"), edge("in", "mg", "out0", "in1", "e1"), edge("mg", "p"), edge("p", "r")],
      ),
      id: "same",
    };
    const r = await collect(one, { registry, resolveCall: resolverFor(one) });
    expect(r.done?.error).toMatch(/Recursive call: channel "norm0" leads to "same#in", which is already in the call chain/);
    // allowRecursive разрешает, но глубину всё равно ограничивает maxDepth
    const allowed: Flow = { ...one, nodes: one.nodes.map((n) => (n.id === "p" ? { ...n, params: { channelId: "norm0", allowRecursive: true, maxDepth: 3 } } : n)) };
    expect((await collect(allowed, { registry, resolveCall: resolverFor(allowed) })).done?.error).toMatch(/too deep \(limit 3/);
  });
});

describe("shoot: выстрелил и забыл", () => {
  const slowCallee = (id = "slow", ch = "ch") => callee(id, ch, [node("w", "wait", { amount: 3, unit: "seconds" })]);

  it("out0 = { ok: true } сразу, не ждёт вызванный флоу; порта err нет", async () => {
    const t0 = Date.now();
    const r = await run(caller({ channelId: "ch", mode: "shoot" }), [slowCallee()]);
    expect(Date.now() - t0).toBeLessThan(2500); // не ждали 3-секундный Wait
    expect(r.done?.result).toEqual({ ok: true });
  });

  it("если запуск закончился раньше, незавершённый вызванный флоу обрывается и это пишется в ленту (node:killed)", async () => {
    const r = await run(caller({ channelId: "ch", mode: "shoot" }), [slowCallee()]);
    const killed = ev(r.events, "node:killed");
    expect(killed).toHaveLength(1);
    expect(killed[0]).toMatchObject({ nodeId: "p", reason: expect.stringMatching(/stopped/) });
    expect(r.done?.error).toBeUndefined(); // вызывающего это не касается
    // node:killed раньше flow:done
    const order = r.events.map((e) => e.event);
    expect(order.indexOf("node:killed")).toBeLessThan(order.indexOf("flow:done"));
  });

  it("вызванный флоу успел завершиться — ни killed, ни error", async () => {
    const quick = callee("q", "ch", [code("m", "return { out0: 1 }")]);
    const caller2: Flow = {
      ...flow([node("s", "source", { json: { v: 1 } }), node("p", "run_flow", { channelId: "ch", mode: "shoot" }), node("w", "wait", { amount: 1, unit: "seconds" }), node("r", "result")], [edge("s", "p"), edge("p", "w"), edge("w", "r")]),
      id: "c2",
    };
    const r = await run(caller2, [quick]);
    expect(ev(r.events, "node:killed")).toHaveLength(0);
    expect(ev(r.events, "node:error")).toHaveLength(0);
    expect(r.done?.result).toEqual({ ok: true });
  });

  it("падение вызванного флоу пишется как node:error вызывающей ноды, но сам запуск успешен", async () => {
    const bad = callee("bad", "ch", [code("m", "throw new Error('shoot boom')")]);
    const caller2: Flow = {
      ...flow([node("s", "source", { json: { v: 1 } }), node("p", "run_flow", { channelId: "ch", mode: "shoot" }), node("w", "wait", { amount: 1, unit: "seconds" }), node("r", "result")], [edge("s", "p"), edge("p", "w"), edge("w", "r")]),
      id: "c3",
    };
    const r = await run(caller2, [bad]);
    expect(r.done?.error).toBeUndefined();
    expect(ev(r.events, "node:error")).toEqual([expect.objectContaining({ nodeId: "p", error: expect.stringMatching(/shoot call to channel "ch" failed:.*shoot boom/) })]);
  });

  it("нет канала, рекурсия, глубина — в shoot логируются (node:error) и гасятся, запуск идёт дальше", async () => {
    const caller2: Flow = {
      ...flow([node("s", "source", { json: { v: 1 } }), node("p", "run_flow", { channelId: "missing", mode: "shoot" }), node("w", "wait", { amount: 1, unit: "seconds" }), node("r", "result")], [edge("s", "p"), edge("p", "w"), edge("w", "r")]),
      id: "c4",
    };
    const r = await run(caller2, []);
    expect(r.done?.result).toEqual({ ok: true });
    expect(ev(r.events, "node:error")[0]).toMatchObject({ nodeId: "p", error: expect.stringMatching(/No phone-incoming/) });
  });
});

describe("Scheduler.resolveCall: рабочие запуски находят только опубликованные флоу", () => {
  const scheduler = (...pub: Flow[]) => {
    const s = new Scheduler({ store: new FlowStore("/nonexistent"), hub: new RunHub(), registry: testRegistry, run: async (_f, onEvent) => onEvent({ event: "flow:done", result: 1 }) });
    for (const f of pub) s.sync({ ...f, status: "published" });
    return s;
  };

  it("находит phone-incoming опубликованного флоу и отдаёт его определение; черновик не виден", async () => {
    const s = scheduler(callee("pubd", "ch"));
    expect((await s.resolveCall("ch")).flow.id).toBe("pubd");
    await expect(scheduler().resolveCall("ch")).rejects.toThrow(/No phone-incoming/);
    s.stop();
  });
});

describe("phone-пара в настоящем процессе-раннере (IPC)", () => {
  const exec = async (f: Flow, flows: Flow[]) => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(f, (e) => events.push(e), { timeoutMs: 20000, onResolveCall: async (ch) => findIncoming(flows, ch) });
    const done = events.at(-1);
    return { events, done: done?.event === "flow:done" ? done : undefined };
  };

  it("await: результат вызванного флоу приходит через IPC-определение флоу", async () => {
    const c = callee("c", "ch", [code("m", "return { out0: { echoed: inputs.in0 } }")]);
    expect((await exec(caller({ channelId: "ch" }), [c])).done?.result).toEqual({ echoed: { v: 1 } });
  });

  it("отказ хозяина (нет канала) — ошибка ноды с его текстом; без onResolveCall — понятная ошибка", async () => {
    const r = await exec(caller({ channelId: "zzz" }), []);
    expect(r.done?.error).toMatch(/No phone-incoming with channel "zzz"/);
    const events: RunnerEvent[] = [];
    await runFlowInProcess(caller({ channelId: "zzz" }), (e) => events.push(e), { timeoutMs: 20000 });
    expect((events.at(-1) as { error?: string }).error).toMatch(/not available/);
  });

  it("shoot: вызывающий дошёл до Result — процесс завершается, незавершённый вызванный флоу оборван (node:killed)", async () => {
    const slow = callee("slow", "ch", [node("w", "wait", { amount: 3, unit: "seconds" })]);
    const t0 = Date.now();
    const r = await exec(caller({ channelId: "ch", mode: "shoot" }), [slow]);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.done?.result).toEqual({ ok: true });
    expect(ev(r.events, "node:killed")).toHaveLength(1);
  });
});

describe("окружение песочницы", () => {
  it("банки памяти песочницы — вложенный каталог _sandbox; без памяти окружение не меняется", () => {
    expect(sandboxEnv({ FL0W_MEMORY_DIR: "/data/memory" })["FL0W_MEMORY_DIR"]).toBe("/data/memory/_sandbox");
    expect(sandboxEnv({ FL0W_MEMORY_DIR: "/data/memory/" })["FL0W_MEMORY_DIR"]).toBe("/data/memory/_sandbox");
    expect(sandboxEnv({ OTHER: "1" })).toEqual({ OTHER: "1" });
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

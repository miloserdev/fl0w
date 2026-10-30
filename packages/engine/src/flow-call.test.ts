import { registry } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { channelsOf, findIncoming, graphsOf, validateCallChannels, validateCallGraph } from "./call-channel";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { runFlowInProcess, sandboxEnv } from "./spawn";
import { FlowStore } from "./store";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { validateFlow } from "./validate";

/** Вызванный флоу: Incoming Call(channel) → [шаги] → Result. */
const callee = (id: string, channel: string, middle: ReturnType<typeof node>[] = [], edges: ReturnType<typeof edge>[] = []): Flow => ({
  ...flow(
    [node("in", "call_trigger", { channelId: channel }), ...middle, node("res", "result")],
    middle.length ? [edge("in", middle[0]!.id), ...edges, edge(middle.at(-1)!.id, "res")] : [edge("in", "res")],
  ),
  id,
});
/** Вызывающий: Source → Outgoing Call → (out0 → Result, err → Result2 по желанию). */
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

describe("пара вызовов: каналы, порты, валидация", () => {
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
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("call_channel");
    const other = callee("other", "chan");
    expect(validateCallChannels(callee("mine", "chan"), [other]).map((i) => i.code)).toEqual(["call_channel"]);
    expect(validateCallChannels(callee("mine", "chan"), [callee("mine", "chan")])).toEqual([]); // тот же флоу — своя прежняя копия
    expect(validateCallChannels(callee("mine", "chan"), [caller({ channelId: "chan" })])).toEqual([]); // другая сторона — это пара
    expect(validateCallChannels(caller({ channelId: "chan" }), [caller({ channelId: "chan" }, { id: "c2" })]).length).toBe(1);
    expect(validateCallChannels(caller({ channelId: "unpaired" }), [])).toEqual([]); // пары может ещё не быть
  });

  it("findIncoming: ровно один; нет или несколько — понятная ошибка; пробелы по краям не значимы", () => {
    expect(findIncoming([callee("a", " c1 ")], "c1").triggerId).toBe("in");
    expect(() => findIncoming([callee("a", "c1")], "zzz")).toThrow(/No incoming call with channel "zzz"/);
    expect(() => findIncoming([callee("a", "c1"), callee("b", "c1")], "c1")).toThrow(/ambiguous/);
    expect(channelsOf(caller({ channelId: "k" }))).toEqual({ incoming: [], outgoing: [{ nodeId: "p", channelId: "k" }] });
  });

  it("incoming call не входит в стартовые: ручной запуск его не поднимает, даже с закреплёнными данными", async () => {
    const f: Flow = { ...flow([{ ...node("in", "call_trigger", { channelId: "c" }), pinData: { out0: { x: 1 } } }, node("r", "result")], [edge("in", "r")]), id: "solo" };
    const r = await collect(f, { registry });
    expect(r.started).toEqual([]);
    expect(r.done?.error).toMatch(/Nothing to start manually/);
  });
});

describe("await: с подтверждением", () => {
  it("out0 — результат вызванного флоу (значение его Result), данные вызова приходят в incoming call", async () => {
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
    expect(r.done?.result).toMatchObject({ message: expect.stringMatching(/No incoming call with channel "nope"/) });
    const r2 = await collect(caller({ channelId: "x" }), { registry });
    expect(r2.done?.error).toMatch(/not available/);
  });

});

describe("await: два графа одного флоу", () => {
  it("вызов отдельного incoming call ТОГО ЖЕ флоу (не связанного с вызывающим графом) — не рекурсия", async () => {
    // граф 1: Manual → Outgoing Call(norm0) → Result; граф 2 (не соединён): Incoming Call(norm0) → Code → Result
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
    expect(ev(r.events, "node:error")[0]).toMatchObject({ nodeId: "p", error: expect.stringMatching(/No incoming call/) });
  });
});

describe("Scheduler.resolveCall: рабочие запуски находят только опубликованные флоу", () => {
  const scheduler = (...pub: Flow[]) => {
    const s = new Scheduler({ store: new FlowStore("/nonexistent"), hub: new RunHub(), registry: testRegistry, run: async (_f, onEvent) => onEvent({ event: "flow:done", result: 1 }) });
    for (const f of pub) s.sync({ ...f, status: "published" });
    return s;
  };

  it("находит incoming call опубликованного флоу и отдаёт его определение; черновик не виден", async () => {
    const s = scheduler(callee("pubd", "ch"));
    expect((await s.resolveCall("ch")).flow.id).toBe("pubd");
    await expect(scheduler().resolveCall("ch")).rejects.toThrow(/No incoming call/);
    s.stop();
  });
});

describe("пара вызовов в настоящем процессе-раннере (IPC)", () => {
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
    expect(r.done?.error).toMatch(/No incoming call with channel "zzz"/);
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

describe("события вложенного запуска", () => {
  const two = (ids: { callee: string }): [Flow, Flow] => {
    const callerFlow: Flow = { ...flow([node("m0", "manual"), node("p", "run_flow", { channelId: "ch", data: { v: 1 } }), node("r", "result")], [edge("m0", "p"), edge("p", "r")]), id: "A" };
    const calleeFlow = callee(ids.callee, "ch", [code("cc", "return { out0: { ok: 1 } }")]);
    return [callerFlow, calleeFlow];
  };
  const started = (r: { events: RunnerEvent[] }) => r.events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));

  it("тот же флоу: ноды вызванного графа видны в ленте (incoming и его цепочка подсвечиваются на холсте)", async () => {
    const one: Flow = {
      ...flow([node("m0", "manual"), node("p", "run_flow", { channelId: "ch", data: { v: 1 } }), node("r", "result"), node("in", "call_trigger", { channelId: "ch" }), code("cc", "return { out0: 1 }"), node("r2", "result")], [edge("m0", "p"), edge("p", "r"), edge("in", "cc"), edge("cc", "r2")]),
      id: "A",
    };
    const r = await collect(one, { registry, resolveCall: resolverFor(one) });
    expect(r.done?.error).toBeUndefined();
    expect(started(r)).toEqual(expect.arrayContaining(["m0", "p", "in", "cc", "r2", "r"]));
    expect(ev(r.events, "flow:done")).toHaveLength(1); // итог один — внутренний не пересылается
  });

  it("другой флоу: события не пересылаются (id нод двух флоу могут совпасть), приходит только итог", async () => {
    const [a, b] = two({ callee: "B" });
    const r = await collect(a, { registry, resolveCall: resolverFor(a, b) });
    expect(started(r)).toEqual(["m0", "p", "r"]);
    expect(r.done?.result).toEqual({ ok: 1 });
  });
});

describe("рекурсии быть не может: Emitter/Loop и Collector не в одном графе", () => {
  const flowOf = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], id = "g"): Flow => ({ ...flow(nodes, edges), id });

  it("графы — компоненты связности (по всем рёбрам, включая ресурсные)", () => {
    const f = flowOf([node("a", "source"), node("b", "noop"), node("c", "source"), node("d", "noop")], [edge("a", "b"), edge("c", "d")]);
    const g = graphsOf(f);
    expect(g.get("a")).toBe(g.get("b"));
    expect(g.get("c")).toBe(g.get("d"));
    expect(g.get("a")).not.toBe(g.get("c"));
  });

  it("Emitter и Collector в одном графе — ошибка валидации, в разных графах одного флоу — можно", () => {
    const same = flowOf(
      [node("in", "call_trigger", { channelId: "c" }), node("m", "noop"), node("p", "run_flow", { channelId: "c" }), node("r", "result")],
      [edge("in", "m"), edge("m", "p"), edge("p", "r")],
    );
    expect(validateCallGraph(same).map((i) => i.code)).toEqual(["call_same_graph"]);
    const v = validateFlow(same, registry);
    expect(!v.ok && v.issues.map((i) => i.code)).toContain("call_same_graph");
    // другой канал не спасает: любой исходящий + любой входящий в одном графе
    const otherChannel = flowOf([node("in", "call_trigger", { channelId: "a" }), node("p", "run_flow", { channelId: "b" })], [edge("in", "p")]);
    expect(validateCallGraph(otherChannel)).toHaveLength(1);
    // граф, соединённый через другой блок (Merge), тоже один граф
    const viaMerge = flowOf(
      [node("m0", "manual"), node("in", "call_trigger", { channelId: "c" }), node("mg", "merge", { wait: "any" }), node("p", "run_flow", { channelId: "c" })],
      [edge("m0", "mg", "out0", "in0", "e0"), edge("in", "mg", "out0", "in1", "e1"), edge("mg", "p")],
    );
    expect(validateCallGraph(viaMerge)).toHaveLength(1);
    // отдельные графы — норма
    const apart = flowOf([node("m0", "manual"), node("p", "run_flow", { channelId: "c" }), node("in", "call_trigger", { channelId: "c" }), node("r", "result")], [edge("m0", "p"), edge("in", "r")]);
    expect(validateCallGraph(apart)).toEqual([]);
  });

  it("Loop считается исходящим вызовом: он не может быть в одном графе с Collector, а канал Loop делит 1:1 с Emitter", () => {
    const same = flowOf([node("in", "call_trigger", { channelId: "body" }), node("l", "loop", { channelId: "body", mode: "times", times: 2 })], [edge("in", "l")]);
    expect(validateCallGraph(same)).toHaveLength(1);
    const two = flowOf([node("l", "loop", { channelId: "body" }), node("p", "run_flow", { channelId: "body" })], []);
    expect(validateCallChannels(two).map((i) => i.code)).toEqual(["call_channel"]);
    expect(channelsOf(flowOf([node("l", "loop", { channelId: "x" })], [])).outgoing).toEqual([{ nodeId: "l", channelId: "x" }]);
  });

  it("следствие: вызванный граф сам никого не вызывает, поэтому цепочек и циклов вызовов не бывает (для повторения — Loop)", async () => {
    // попытка цепочки A → B → C: граф B с Collector не может содержать Emitter — валидатор отклоняет такой B
    const b = flowOf([node("in", "call_trigger", { channelId: "ab" }), node("p", "run_flow", { channelId: "bc" })], [edge("in", "p")], "B");
    expect(validateFlow(b, registry).ok).toBe(false);
  });
});

describe("Loop: повторение без рекурсии", () => {
  const body = (code_: string, id = "body"): Flow => callee(id, "body-ch", [code("m", code_)]);
  const looper = (params: Record<string, Json>, input: Json = [1, 2, 3], extra: { err?: boolean } = {}): Flow => ({
    ...flow(
      [node("s", "source", { json: input }), node("l", "loop", { channelId: "body-ch", ...params }), node("r", "result"), ...(extra.err ? [node("er", "result")] : [])],
      [edge("s", "l"), edge("l", "r"), ...(extra.err ? [edge("l", "er", "err", "in0", "e-err")] : [])],
    ),
    id: "looper",
  });

  it("по элементам массива: тело получает { item, index, total }, результаты собираются в массив по порядку", async () => {
    const r = await run(looper({}), [body("return { out0: { n: inputs.in0.item * 10, i: inputs.in0.index, of: inputs.in0.total } }")]);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([{ n: 10, i: 0, of: 3 }, { n: 20, i: 1, of: 3 }, { n: 30, i: 2, of: 3 }]);
  });

  it("path берёт массив из входа; times — N повторов с item = номер", async () => {
    const withPath = await run(looper({ path: "rows" }, { rows: ["a", "b"] }), [body("return { out0: inputs.in0.item }")]);
    expect(withPath.done?.result).toEqual(["a", "b"]);
    const times = await run(looper({ mode: "times", times: 4 }, { any: 1 }), [body("return { out0: inputs.in0.item }")]);
    expect(times.done?.result).toEqual([0, 1, 2, 3]);
  });

  it("порядок результатов сохраняется при concurrency > 1, даже если итерации кончаются не по порядку", async () => {
    // чем меньше item, тем дольше Wait: без сортировки по индексу порядок бы перевернулся
    const slowFirst = callee("body", "body-ch", [node("w", "wait", { amount: 1, unit: "seconds" })]);
    const fast = body("return { out0: inputs.in0.item }");
    const t0 = Date.now();
    const r = await run(looper({ concurrency: 3 }, [1, 2, 3]), [fast]);
    expect(r.done?.result).toEqual([1, 2, 3]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(slowFirst.id).toBe("body");
    // параллельность реальна: три Wait по секунде при concurrency 3 укладываются примерно в секунду, а не в три
    const waitBody = callee("body", "body-ch", [node("w", "wait", { amount: 1, unit: "seconds" })]);
    const t1 = Date.now();
    await run(looper({ concurrency: 3 }, [1, 2, 3]), [waitBody]);
    expect(Date.now() - t1).toBeLessThan(2200);
  });

  it("onError: stop — первая ошибка тела роняет ноду; continue — упавшие пропускаются, ошибки идут в порт err", async () => {
    const b = body("if (inputs.in0.item === 2) throw new Error('bad item'); return { out0: inputs.in0.item }");
    const stop = await run(looper({}), [b]);
    expect(stop.done?.error).toMatch(/Loop item 1 failed:.*bad item/);
    const cont = await run(looper({ onError: "continue" }, [1, 2, 3], { err: true }), [b]);
    expect(cont.done?.error).toBeUndefined();
    const res = cont.done?.result as Record<string, Json>;
    expect(res["r"]).toEqual([1, 3]);
    expect(res["er"]).toEqual([{ index: 1, item: 2, error: expect.stringContaining("bad item") }]);
  });

  it("порт err есть только при onError: continue; вход не массив, лимит итераций, нет канала — понятные ошибки", async () => {
    expect(validateFlow(looper({ onError: "continue" }, [1], { err: true }), registry).ok).toBe(true);
    expect(validateFlow(looper({}, [1], { err: true }), registry).ok).toBe(false);
    expect((await run(looper({}, { not: "array" }), [body("return { out0: 1 }")])).done?.error).toMatch(/must be an array/);
    expect((await run(looper({ path: "x" }, { x: 5 }), [body("return { out0: 1 }")])).done?.error).toMatch(/"x" is not an array/);
    expect((await run(looper({}, Array.from({ length: 1001 }, (_, i) => i)), [body("return { out0: 1 }")])).done?.error).toMatch(/Too many items/);
    expect((await run(looper({ channelId: "nope" }), [])).done?.error).toMatch(/No incoming call with channel "nope"/);
  });

  it("пустой массив — пустой результат без вызовов тела", async () => {
    const r = await run(looper({ path: "rows" }, { rows: [] }), [body("throw new Error('must not run')")]);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([]);
  });
});

import { registry } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";
import { validateFlow } from "./validate";

const code = (id: string, body: string) => node(id, "code", { code: body });
const run = (f: Flow, extra: Record<string, unknown> = {}) => collect(f, { registry, ...extra });
const started = (events: RunnerEvent[], id: string) => events.filter((e) => e.event === "node:start" && e.nodeId === id).length;

/**
 * Source(input) → Loop; Loop.each → [body] → Result(rb); Loop.done → Result(rd).
 * `body` — цепочка нод тела (первая получает { item, index, total }); её последняя нода идёт в Result тела `rb`.
 */
function loopFlow(loopParams: Record<string, Json>, input: Json, bodyNodes: ReturnType<typeof node>[], bodyEdges: ReturnType<typeof edge>[] = []): Flow {
  const first = bodyNodes[0]!.id;
  const last = bodyNodes.at(-1)!.id;
  return flow(
    [node("s", "source", { json: input }), node("l", "loop", loopParams), ...bodyNodes, node("rb", "result"), node("rd", "result")],
    [edge("s", "l"), edge("l", first, "body", "in0", "e-each"), ...bodyEdges, edge(last, "rb"), edge("l", "rd", "out0", "in0", "e-done")],
  );
}

describe("Loop: items", () => {
  it("тело исполняется на каждый элемент, на выходе done — массив результатов тела по порядку; Result тела в итог запуска не попадает", async () => {
    const f = loopFlow({}, [1, 2, 3], [code("c", "return { out0: { n: inputs.in0.item * 10, i: inputs.in0.index, of: inputs.in0.total } }")]);
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([{ n: 10, i: 0, of: 3 }, { n: 20, i: 1, of: 3 }, { n: 30, i: 2, of: 3 }]);
    expect(started(r.events, "c")).toBe(3); // события нод тела видны на холсте
    expect(started(r.events, "rb")).toBe(3);
  });

  it("path берёт массив из входа; пустой массив — пустой результат без запуска тела; вход не массив — ошибка", async () => {
    const body = [code("c", "return { out0: inputs.in0.item }")];
    expect((await run(loopFlow({ path: "rows" }, { rows: ["a", "b"] }, body))).done?.result).toEqual(["a", "b"]);
    const empty = await run(loopFlow({ path: "rows" }, { rows: [] }, [code("c", "throw new Error('must not run')")]));
    expect(empty.done?.result).toEqual([]);
    expect(started(empty.events, "c")).toBe(0);
    expect((await run(loopFlow({}, { not: "array" }, body))).done?.error).toMatch(/must be an array/);
    expect((await run(loopFlow({ path: "x" }, { x: 5 }, body))).done?.error).toMatch(/"x" is not an array/);
  });

  it("тело исполняется только циклом: Merge(any) в теле с внешним входом не срабатывает в основном потоке лишний раз", async () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("k", "source", { json: { ext: 1 } }), node("l", "loop"), node("m", "merge", { mode: "array", wait: "any" }), node("rb", "result"), node("rd", "result")],
      [edge("s", "l"), edge("l", "m", "body", "in0", "eb"), edge("k", "m", "out0", "in1", "ek"), edge("m", "rb"), edge("l", "rd", "out0", "in0", "ed")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(started(r.events, "m")).toBe(2); // ровно по итерации; в основном потоке (только внешний вход) — ни разу
    expect(r.done?.result).toEqual([[{ item: 1, index: 0, total: 2 }, { ext: 1 }], [{ item: 2, index: 1, total: 2 }, { ext: 1 }]]);
  });

  it("нода без Result в теле даёт null на итерацию; цикл без тела — понятная ошибка", async () => {
    const noResult: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("l", "loop"), code("c", "return { out0: 1 }"), node("rd", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("l", "rd", "out0", "in0", "ed")],
    );
    expect((await run(noResult)).done?.result).toEqual([null, null]);
    const bodyless: Flow = flow([node("s", "source", { json: [1] }), node("l", "loop"), node("rd", "result")], [edge("s", "l"), edge("l", "rd", "out0", "in0", "ed")]);
    expect((await run(bodyless)).done?.error).toMatch(/has no body/);
  });

  it("тело получает и данные снаружи (вторые входы нод тела берутся из уже вычисленных нод вне тела)", async () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("k", "source", { json: { mult: 100 } }), node("l", "loop"), node("c", "code", { code: "return { out0: inputs.in0.item * inputs.in1.mult }" }), node("rb", "result"), node("rd", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("k", "c", "out0", "in1", "ek"), edge("c", "rb"), edge("l", "rd", "out0", "in0", "ed")],
    );
    // у code один вход in0 — второй порт добавляем через portsOverride
    f.nodes = f.nodes.map((n) => (n.id === "c" ? { ...n, portsOverride: { inputs: [{ id: "in1" }], outputs: [] } } : n));
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([100, 200]);
  });
});

describe("Loop: count / while / forever", () => {
  const body = [code("c", "return { out0: inputs.in0.item }")];

  it("count: от from до to (не включая) с шагом; отрицательный шаг идёт вниз; пустой диапазон — ноль итераций", async () => {
    expect((await run(loopFlow({ mode: "count", from: 0, to: 4 }, { a: 1 }, body))).done?.result).toEqual([0, 1, 2, 3]);
    expect((await run(loopFlow({ mode: "count", from: 1, to: 10, step: 3 }, { a: 1 }, body))).done?.result).toEqual([1, 4, 7]);
    expect((await run(loopFlow({ mode: "count", from: 5, to: 2, step: -1 }, { a: 1 }, body))).done?.result).toEqual([5, 4, 3]);
    expect((await run(loopFlow({ mode: "count", from: 5, to: 2 }, { a: 1 }, body))).done?.result).toEqual([]);
    expect((await run(loopFlow({ mode: "count", step: 0 }, { a: 1 }, body))).done?.error).toMatch(/"step" must not be zero/);
  });

  it("while: пока условие над результатом предыдущей итерации (для первой — над входом) истинно", async () => {
    const f = loopFlow({ mode: "while", field: "n", operator: "lt", value: 3 }, { n: 0 }, [code("c", "return { out0: { n: inputs.in0.item.n + 1 } }")]);
    const r = await run(f);
    expect(r.done?.result).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // условие ложно сразу — ни одной итерации
    expect((await run(loopFlow({ mode: "while", field: "n", operator: "lt", value: 0 }, { n: 0 }, body))).done?.result).toEqual([]);
  });

  it("forever (while true) останавливает блок Break в теле; результат — по итерацию включительно", async () => {
    // тело: Code → Result тела; Code → Branch (i >= 2) → Break
    const f: Flow = flow(
      [
        node("s", "source", { json: { a: 1 } }),
        node("l", "loop", { mode: "forever" }),
        code("c", "return { out0: { i: inputs.in0.index } }"),
        node("br", "branch", { field: "i", operator: "gte", value: 2 }),
        node("brk", "loop_break"),
        node("rb", "result"),
        node("rd", "result"),
      ],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("c", "rb"), edge("c", "br", "out0", "in0", "ebr"), edge("br", "brk", "out0", "in0", "ebk"), edge("l", "rd", "out0", "in0", "ed")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("лимит итераций: бесконечный цикл без Break — ошибка, а не зависание; items длиннее лимита — ошибка", async () => {
    const forever = await run(loopFlow({ mode: "forever", maxIterations: 5 }, { a: 1 }, body));
    expect(forever.done?.error).toMatch(/reached maxIterations \(5\)/);
    expect(started(forever.events, "c")).toBe(5);
    expect((await run(loopFlow({ maxIterations: 3 }, [1, 2, 3, 4], body))).done?.error).toMatch(/Too many items/);
    expect((await run(loopFlow({ mode: "count", from: 0, to: 100, maxIterations: 10 }, { a: 1 }, body))).done?.error).toMatch(/Too many iterations/);
  });

  it("Break вне тела цикла — ошибка", async () => {
    const f = flow([node("s", "source", { json: 1 }), node("b", "loop_break"), node("r", "result")], [edge("s", "b"), edge("b", "r")]);
    expect((await run(f)).done?.error).toMatch(/only be used inside the body of a Loop/);
  });
});

describe("Loop: ошибки итераций, вложенность, события", () => {
  it("onError: stop — ошибка итерации роняет цикл (и запуск); continue — итерация пропускается, остальные идут", async () => {
    const body = [code("c", "if (inputs.in0.item === 2) throw new Error('bad item'); return { out0: inputs.in0.item }")];
    const stop = await run(loopFlow({}, [1, 2, 3], body));
    expect(stop.done?.error).toMatch(/Loop iteration 1 failed:.*bad item/);
    const cont = await run(loopFlow({ onError: "continue" }, [1, 2, 3], body));
    expect(cont.done?.error).toBeUndefined();
    expect(cont.done?.result).toEqual([1, 3]);
  });

  it("вложенные циклы: тело внешнего содержит внутренний цикл со своим телом", async () => {
    const f: Flow = flow(
      [
        node("s", "source", { json: [[1, 2], [3]] }),
        node("outer", "loop"),
        node("inner", "loop", { path: "item" }),
        code("c", "return { out0: inputs.in0.item * 2 }"),
        node("rbi", "result"),
        node("rbo", "result"),
        node("rd", "result"),
      ],
      [
        edge("s", "outer"),
        edge("outer", "inner", "body", "in0", "e1"),
        edge("inner", "c", "body", "in0", "e2"),
        edge("c", "rbi"),
        edge("inner", "rbo", "out0", "in0", "e3"),
        edge("outer", "rd", "out0", "in0", "e4"),
      ],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([[2, 4], [6]]);
  });

  it("цикл внутри ветки: после цикла нода получает массив результатов, остальные ветки не страдают", async () => {
    const f = loopFlow({}, [1, 2], [code("c", "return { out0: inputs.in0.item }")]);
    f.nodes.push(node("sum", "code", { code: "return { out0: inputs.in0.reduce((a, b) => a + b, 0) }" }));
    f.edges = f.edges.map((e) => (e.id === "e-done" ? { ...e, target: "sum" } : e));
    f.edges.push(edge("sum", "rd"));
    expect((await run(f)).done?.result).toEqual(3);
  });

  it("события нод тела идут только у первых 20 итераций (с пометкой), результат при этом полный", async () => {
    const r = await run(loopFlow({ mode: "count", from: 0, to: 60 }, { a: 1 }, [code("c", "return { out0: inputs.in0.item }")]));
    expect(r.done?.error).toBeUndefined();
    expect((r.done?.result as Json[]).length).toBe(60);
    expect(started(r.events, "c")).toBe(20);
    expect(r.events.some((e) => e.event === "node:log" && e.nodeId === "l" && /not shown/.test(e.message))).toBe(true);
  });

  it("быстрый: 300 итераций с кодом укладываются в разумное время (флоу не перепроверяется на каждой итерации)", async () => {
    const t0 = Date.now();
    const r = await run(loopFlow({ mode: "count", from: 0, to: 300 }, { a: 1 }, [node("c", "noop")]));
    expect(r.done?.error).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("отмена (signal) останавливает цикл", async () => {
    const ac = new AbortController();
    const f = loopFlow({ mode: "forever", maxIterations: 10_000 }, { a: 1 }, [node("w", "wait", { amount: 1, unit: "seconds" })]);
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await run(f, { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.done?.error).toMatch(/Aborted/);
  });
});

describe("Loop: валидация", () => {
  it("тело не должно пересекаться с продолжением после цикла", () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1] }), node("l", "loop"), node("c", "noop"), node("r", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "e1"), edge("c", "r"), edge("l", "c", "out0", "in0", "e2")],
    );
    const v = validateFlow(f, registry);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["loop_body_overlap"]));
  });

  it("порты: out0 («готово») и body («каждая итерация»); при нескольких циклах каждый со своим телом", () => {
    expect(registry["loop"]!.ports.outputs.map((p) => p.id)).toEqual(["out0", "body"]);
    expect(registry["loop"]!.bodyPort).toBe("body");
    expect(registry["noop"]!.bodyPort).toBeNull();
  });
});

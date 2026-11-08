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
 * `body` is a chain of body nodes (the first receives { item, index, total }); its last node goes into the body's Result `rb`.
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
  it("the body runs for each element, and the done output is an array of body results in order; the body's Result does not end up in the run result", async () => {
    const f = loopFlow({}, [1, 2, 3], [code("c", "return { out0: { n: inputs.in0.item * 10, i: inputs.in0.index, of: inputs.in0.total } }")]);
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([{ n: 10, i: 0, of: 3 }, { n: 20, i: 1, of: 3 }, { n: 30, i: 2, of: 3 }]);
    expect(started(r.events, "c")).toBe(3); // body node events are visible on the canvas
    expect(started(r.events, "rb")).toBe(3);
  });

  it("path takes the array from the input; an empty array gives an empty result without running the body; a non-array input is an error", async () => {
    const body = [code("c", "return { out0: inputs.in0.item }")];
    expect((await run(loopFlow({ path: "rows" }, { rows: ["a", "b"] }, body))).done?.result).toEqual(["a", "b"]);
    const empty = await run(loopFlow({ path: "rows" }, { rows: [] }, [code("c", "throw new Error('must not run')")]));
    expect(empty.done?.result).toEqual([]);
    expect(started(empty.events, "c")).toBe(0);
    expect((await run(loopFlow({}, { not: "array" }, body))).done?.error).toMatch(/must be an array/);
    expect((await run(loopFlow({ path: "x" }, { x: 5 }, body))).done?.error).toMatch(/"x" is not an array/);
  });

  it("the body is executed only by the loop: Merge(any) in the body with an external input does not fire an extra time in the main flow", async () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("k", "source", { json: { ext: 1 } }), node("l", "loop"), node("m", "merge", { mode: "array", wait: "any" }), node("rb", "result"), node("rd", "result")],
      [edge("s", "l"), edge("l", "m", "body", "in0", "eb"), edge("k", "m", "out0", "in1", "ek"), edge("m", "rb"), edge("l", "rd", "out0", "in0", "ed")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(started(r.events, "m")).toBe(2); // exactly once per iteration; in the main flow (external input only) never
    expect(r.done?.result).toEqual([[{ item: 1, index: 0, total: 2 }, { ext: 1 }], [{ item: 2, index: 1, total: 2 }, { ext: 1 }]]);
  });

  it("a node without a Result in the body gives null per iteration; a loop without a body is a clear error", async () => {
    const noResult: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("l", "loop"), code("c", "return { out0: 1 }"), node("rd", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("l", "rd", "out0", "in0", "ed")],
    );
    expect((await run(noResult)).done?.result).toEqual([null, null]);
    const bodyless: Flow = flow([node("s", "source", { json: [1] }), node("l", "loop"), node("rd", "result")], [edge("s", "l"), edge("l", "rd", "out0", "in0", "ed")]);
    expect((await run(bodyless)).done?.error).toMatch(/has no body/);
  });

  it("the body also receives data from outside (second inputs of body nodes are taken from already computed nodes outside the body)", async () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("k", "source", { json: { mult: 100 } }), node("l", "loop"), node("c", "code", { code: "return { out0: inputs.in0.item * inputs.in1.mult }" }), node("rb", "result"), node("rd", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("k", "c", "out0", "in1", "ek"), edge("c", "rb"), edge("l", "rd", "out0", "in0", "ed")],
    );
    // code has one input in0; the second port is added via portsOverride
    f.nodes = f.nodes.map((n) => (n.id === "c" ? { ...n, portsOverride: { inputs: [{ id: "in1" }], outputs: [] } } : n));
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([100, 200]);
  });
});

describe("Loop: count / while / forever", () => {
  const body = [code("c", "return { out0: inputs.in0.item }")];

  it("count: from `from` to `to` (exclusive) with a step; a negative step goes down; an empty range is zero iterations", async () => {
    expect((await run(loopFlow({ mode: "count", from: 0, to: 4 }, { a: 1 }, body))).done?.result).toEqual([0, 1, 2, 3]);
    expect((await run(loopFlow({ mode: "count", from: 1, to: 10, step: 3 }, { a: 1 }, body))).done?.result).toEqual([1, 4, 7]);
    expect((await run(loopFlow({ mode: "count", from: 5, to: 2, step: -1 }, { a: 1 }, body))).done?.result).toEqual([5, 4, 3]);
    expect((await run(loopFlow({ mode: "count", from: 5, to: 2 }, { a: 1 }, body))).done?.result).toEqual([]);
    expect((await run(loopFlow({ mode: "count", step: 0 }, { a: 1 }, body))).done?.error).toMatch(/"step" must not be zero/);
  });

  it("while: as long as the condition over the previous iteration's result (for the first, over the input) is true", async () => {
    const f = loopFlow({ mode: "while", field: "n", operator: "lt", value: 3 }, { n: 0 }, [code("c", "return { out0: { n: inputs.in0.item.n + 1 } }")]);
    const r = await run(f);
    expect(r.done?.result).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // the condition is false right away: no iterations
    expect((await run(loopFlow({ mode: "while", field: "n", operator: "lt", value: 0 }, { n: 0 }, body))).done?.result).toEqual([]);
  });

  it("forever (while true) is stopped by a Break block in the body; the result goes up to and including that iteration", async () => {
    // body: Code → body Result; Code → Branch (i >= 2) → Break
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

  it("iteration limit: an infinite loop without Break is an error, not a hang; items longer than the limit are an error", async () => {
    const forever = await run(loopFlow({ mode: "forever", maxIterations: 5 }, { a: 1 }, body));
    expect(forever.done?.error).toMatch(/reached maxIterations \(5\)/);
    expect(started(forever.events, "c")).toBe(5);
    expect((await run(loopFlow({ maxIterations: 3 }, [1, 2, 3, 4], body))).done?.error).toMatch(/Too many items/);
    expect((await run(loopFlow({ mode: "count", from: 0, to: 100, maxIterations: 10 }, { a: 1 }, body))).done?.error).toMatch(/Too many iterations/);
  });

  it("Break outside a loop body is an error", async () => {
    const f = flow([node("s", "source", { json: 1 }), node("b", "loop_break"), node("r", "result")], [edge("s", "b"), edge("b", "r")]);
    expect((await run(f)).done?.error).toMatch(/only be used inside the body of a Loop/);
  });
});

describe("Loop: iteration errors, nesting, events", () => {
  it("onError: stop — an iteration error brings down the loop (and the run); continue — the iteration is skipped, the others go on", async () => {
    const body = [code("c", "if (inputs.in0.item === 2) throw new Error('bad item'); return { out0: inputs.in0.item }")];
    const stop = await run(loopFlow({}, [1, 2, 3], body));
    expect(stop.done?.error).toMatch(/Loop iteration 1 failed:.*bad item/);
    // err port: errors of failed iterations come out separately rather than getting lost in the log
    const withErr: Flow = loopFlow({ onError: "continue" }, [1, 2, 3], body);
    withErr.nodes.push(node("re", "result"));
    withErr.edges.push(edge("l", "re", "err", "in0", "e-err"));
    const cont = await run(withErr);
    expect(cont.done?.error).toBeUndefined();
    const res = cont.done?.result as Record<string, Json>;
    expect(res["rd"]).toEqual([1, 3]);
    expect(res["re"]).toEqual([{ index: 1, item: 2, error: expect.stringContaining("bad item") }]);
    // without errors the err port is silent
    const clean = await run(withErr.nodes.length ? { ...withErr, nodes: withErr.nodes.map((n) => (n.id === "c" ? { ...n, params: { code: "return { out0: inputs.in0.item }" } } : n)) } : withErr);
    expect(clean.done?.result).toEqual([1, 2, 3]);
  });

  it("the err port exists only with onError: continue (an edge to it with stop is rejected by the validator)", () => {
    const f = loopFlow({}, [1], [code("c", "return { out0: 1 }")]);
    f.nodes.push(node("re", "result"));
    f.edges.push(edge("l", "re", "err", "in0", "e-err"));
    expect(validateFlow(f, registry).ok).toBe(false);
    expect(validateFlow({ ...f, nodes: f.nodes.map((n) => (n.id === "l" ? { ...n, params: { onError: "continue" } } : n)) }, registry).ok).toBe(true);
  });

  it("nested loops: the outer body contains an inner loop with its own body", async () => {
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

  it("a loop inside a branch: after the loop the node gets an array of results, the other branches are unaffected", async () => {
    const f = loopFlow({}, [1, 2], [code("c", "return { out0: inputs.in0.item }")]);
    f.nodes.push(node("sum", "code", { code: "return { out0: inputs.in0.reduce((a, b) => a + b, 0) }" }));
    f.edges = f.edges.map((e) => (e.id === "e-done" ? { ...e, target: "sum" } : e));
    f.edges.push(edge("sum", "rd"));
    expect((await run(f)).done?.result).toEqual(3);
  });

  it("body node events go only for the first 20 iterations (with a marker), while the result is complete", async () => {
    const r = await run(loopFlow({ mode: "count", from: 0, to: 60 }, { a: 1 }, [code("c", "return { out0: inputs.in0.item }")]));
    expect(r.done?.error).toBeUndefined();
    expect((r.done?.result as Json[]).length).toBe(60);
    expect(started(r.events, "c")).toBe(20);
    expect(r.events.some((e) => e.event === "node:log" && e.nodeId === "l" && /not shown/.test(e.message))).toBe(true);
  });

  it("fast: 300 iterations with code fit into a reasonable time (the flow is not re-validated on every iteration)", async () => {
    const t0 = Date.now();
    const r = await run(loopFlow({ mode: "count", from: 0, to: 300 }, { a: 1 }, [node("c", "noop")]));
    expect(r.done?.error).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("cancellation (signal) stops the loop", async () => {
    const ac = new AbortController();
    const f = loopFlow({ mode: "forever", maxIterations: 10_000 }, { a: 1 }, [node("w", "wait", { amount: 1, unit: "seconds" })]);
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await run(f, { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.done?.error).toMatch(/Aborted/);
  });
});

describe("Loop: external body inputs", () => {
  /** The body takes its second input from a SLOW node outside the body (Source → Wait): the loop must wait for it rather than start without data. */
  const slowFeeder = (waitMs: number): Flow => {
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("k", "source", { json: { mult: 100 } }), node("w", "wait", { amount: waitMs / 1000, unit: "seconds" }), node("l", "loop"), node("c", "code", { code: "return { out0: inputs.in0.item * inputs.in1.mult }" }), node("rb", "result"), node("rd", "result")],
      [edge("s", "l", "out0", "in0", "e1"), edge("l", "c", "body", "in0", "e2"), edge("k", "w", "out0", "in0", "e3"), edge("w", "c", "out0", "in1", "e4"), edge("c", "rb", "out0", "in0", "e5"), edge("l", "rd", "out0", "in0", "e6")],
    );
    f.nodes = f.nodes.map((n) => (n.id === "c" ? { ...n, portsOverride: { inputs: [{ id: "in1" }], outputs: [] } } : n));
    return f;
  };

  it("the loop waits for a slow external body input (previously the body started without it, and the result was [null, null] as a \"success\")", async () => {
    const r = await run(slowFeeder(300));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([100, 200]);
  });

  it("an external input that did not arrive (the branch did not go) does not hang the loop: the body node is skipped as usual", async () => {
    const f = slowFeeder(10);
    // k → Branch(false) → Wait: the value will not reach the body
    f.nodes.push(node("br", "branch", { field: "mult", operator: "eq", value: 1 }));
    f.edges = f.edges.filter((e) => e.id !== "e3").concat([edge("k", "br", "out0", "in0", "e3a"), edge("br", "w", "out0", "in0", "e3b")]);
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual([null, null]);
  });
});

describe("Loop: validation", () => {
  it("the body must not overlap with the continuation after the loop", () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1] }), node("l", "loop"), node("c", "noop"), node("r", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "e1"), edge("c", "r"), edge("l", "c", "out0", "in0", "e2")],
    );
    const v = validateFlow(f, registry);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["loop_body_overlap"]));
  });

  it("ports: out0 (\"done\") and body (\"each iteration\"); with several loops each has its own body", () => {
    expect(registry["loop"]!.ports.outputs.map((p) => p.id)).toEqual(["out0", "body"]);
    expect(registry["loop"]!.bodyPort).toBe("body");
    expect(registry["noop"]!.bodyPort).toBeNull();
  });
});

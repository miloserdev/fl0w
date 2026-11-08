import { Block, registry } from "@fl0w/blocks";
import type { Json, ParamSchema } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

/** A "slow" block: sleeps `ms` (cancellable) and counts how many such blocks run at once. */
let current = 0;
let peak = 0;
class Sleep extends Block {
  static type = "sleep";
  static label = "Sleep";
  static icon = "box";
  static category = "test";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [{ name: "ms", type: "number", default: 100 }];
  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: { signal: AbortSignal }) {
    current++;
    peak = Math.max(peak, current);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Number(params["ms"]));
        ctx.signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("Aborted"))), { once: true });
      });
      return { out0: inputs["in0"] ?? null };
    } finally {
      current--;
    }
  }
}
const reg = { ...registry, sleep: Sleep as unknown as (typeof registry)[string] };
const run = (f: ReturnType<typeof flow>) => collect(f, { registry: reg });
const order = (events: { event: string; nodeId?: string }[], kind: string) => events.flatMap((e) => (e.event === kind ? [e.nodeId] : []));

describe("parallel execution of independent branches", () => {
  it("two independent branches go at once: total time ≈ the longest, not the sum", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), node("a", "sleep", { ms: 1000 }), node("b", "sleep", { ms: 1000 }), node("ra", "result"), node("rb", "result")],
      [edge("s", "a"), edge("s", "b"), edge("a", "ra"), edge("b", "rb")],
    );
    const t0 = Date.now();
    const r = await run(f);
    const ms = Date.now() - t0;
    expect(r.done?.error).toBeUndefined();
    expect(ms).toBeLessThan(1700); // sequentially it would be ≥ 2000; big margin so the test does not flake under load
    expect(r.done?.result).toEqual({ ra: { v: 1 }, rb: { v: 1 } }); // key order is topological, as before
  });

  it("a long node does not delay a neighbouring graph: the fast one finishes before the slow one", async () => {
    // two unconnected graphs in one flow: Manual → Sleep(600) → Result and Manual → Code → Result
    const f = flow(
      [node("m1", "manual"), node("slow", "sleep", { ms: 600 }), node("r1", "result"), node("m2", "manual"), node("fast", "code", { code: "return { out0: 1 }" }), node("r2", "result")],
      [edge("m1", "slow"), edge("slow", "r1"), edge("m2", "fast"), edge("fast", "r2")],
    );
    const r = await run(f);
    const done = order(r.events, "node:done");
    expect(done.indexOf("fast")).toBeLessThan(done.indexOf("slow"));
    expect(done.indexOf("r2")).toBeLessThan(done.indexOf("slow"));
    expect(r.done?.error).toBeUndefined();
  });

  it("a dependent node waits for exactly its own inputs: the branch behind a slow node goes after it", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), node("slow", "sleep", { ms: 300 }), node("after", "code", { code: "return { out0: inputs.in0 }" }), node("r", "result")],
      [edge("s", "slow"), edge("slow", "after"), edge("after", "r")],
    );
    const r = await run(f);
    expect(order(r.events, "node:start")).toEqual(["s", "slow", "after", "r"]);
    expect(r.done?.result).toEqual({ v: 1 });
  });

  it("Merge waits for all branches (all) and goes on those that arrived (any): input semantics are preserved under parallel execution", async () => {
    const mk = (wait: string) =>
      flow(
        [node("s", "source", { json: { x: 1 } }), node("a", "sleep", { ms: 300 }), node("b", "branch", { field: "x", operator: "eq", value: 1 }), node("m", "merge", { mode: "array", wait }), node("r", "result")],
        [edge("s", "a"), edge("s", "b"), edge("a", "m", "out0", "in0"), edge("b", "m", "out1", "in1", "e-false"), edge("m", "r")],
      );
    expect((await run(mk("all"))).started).not.toContain("m"); // the false branch did not go
    expect((await run(mk("any"))).done?.result).toEqual([{ x: 1 }]);
  });

  it("a failure of one branch aborts the others: the run finishes at once, the aborted node has no extra node:error", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), node("slow", "sleep", { ms: 5000 }), node("bad", "code", { code: "throw new Error('boom')" }), node("r1", "result"), node("r2", "result")],
      [edge("s", "slow"), edge("s", "bad"), edge("slow", "r1"), edge("bad", "r2")],
    );
    const t0 = Date.now();
    const r = await run(f);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.done?.error).toMatch(/Node "bad" failed: boom/);
    expect(order(r.events, "node:error")).toEqual(["bad"]);
    expect(r.events.at(-1)?.event).toBe("flow:done");
  });

  it("the number of simultaneously executing nodes is limited (16)", async () => {
    peak = 0;
    const n = 40;
    const nodes = [node("s", "source", { json: { v: 1 } })];
    const edges = [];
    for (let i = 0; i < n; i++) {
      nodes.push(node(`w${i}`, "sleep", { ms: 60 }), node(`r${i}`, "result"));
      edges.push(edge("s", `w${i}`), edge(`w${i}`, `r${i}`));
    }
    const r = await run(flow(nodes, edges));
    expect(r.done?.error).toBeUndefined();
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(4); // really in parallel
  });

  it("cancellation (signal) during parallel nodes stops the run", async () => {
    const ac = new AbortController();
    const f = flow([node("s", "source", { json: 1 }), node("a", "sleep", { ms: 5000 }), node("b", "sleep", { ms: 5000 }), node("r", "result")], [edge("s", "a"), edge("s", "b"), edge("a", "r", "out0", "in0", "ea")]);
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const r = await collect(f, { registry: reg, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.done?.error).toMatch(/Aborted/);
  });
});

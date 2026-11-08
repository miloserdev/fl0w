import { registry } from "@fl0w/blocks";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

/**
 * Source → Branch(x == 1) → true: Merge.in0, false: Merge.in1; plus Source2 → Merge.in2.
 * The "false" branch does not go, so input in1 stays empty.
 */
const f = (merge: Record<string, unknown>, x = 1) =>
  flow(
    [
      node("s", "source", { json: { x } }),
      node("b", "branch", { field: "x", operator: "eq", value: 1 }),
      node("s2", "source", { json: { y: 2 } }),
      node("m", "merge", merge as never),
      node("r", "result"),
    ],
    [edge("s", "b"), edge("b", "m", "out0", "in0"), edge("b", "m", "out1", "in1"), edge("s2", "m", "out0", "in2"), edge("m", "r")],
  );
const run = (fl: ReturnType<typeof f>) => collect(fl, { registry });

describe("Merge: wait all / any", () => {
  it("by default (all) waits for all connected inputs: if a branch did not go, Merge does not run", async () => {
    const r = await run(f({ mode: "array" }));
    expect(r.started).not.toContain("m");
    expect(r.done?.result).toBeUndefined();
  });

  it("any runs on the inputs that arrived and skips the branch that did not go", async () => {
    const r = await run(f({ mode: "object", wait: "any" }));
    expect(r.started).toContain("m");
    expect(r.done?.result).toEqual({ in0: { x: 1 }, in2: { y: 2 } });
  });

  it("any: the other side of the branch, in1 arrives instead of in0; array collects by port numbers", async () => {
    const r = await run(f({ mode: "array", wait: "any" }, 5));
    expect(r.done?.result).toEqual([{ x: 5 }, { y: 2 }]);
  });

  it("any, but no input arrived: Merge does not run", async () => {
    const none = flow(
      [node("s", "source", { json: { x: 5 } }), node("b", "branch", { field: "x", operator: "eq", value: 1 }), node("m", "merge", { wait: "any" }), node("r", "result")],
      [edge("s", "b"), edge("b", "m", "out0", "in0"), edge("m", "r")],
    );
    const r = await run(none);
    expect(r.started).not.toContain("m");
  });

  it("any, when all inputs arrived, behaves like all", async () => {
    const all = flow(
      [node("a", "source", { json: { a: 1 } }), node("b", "source", { json: { b: 2 } }), node("m", "merge", { mode: "assign", wait: "any" }), node("r", "result")],
      [edge("a", "m", "out0", "in0"), edge("b", "m", "out0", "in1"), edge("m", "r")],
    );
    expect((await run(all)).done?.result).toEqual({ a: 1, b: 2 });
  });

  it("an unknown wait value is treated as all (safe default behaviour)", async () => {
    expect((await run(f({ mode: "array", wait: "whatever" }))).started).not.toContain("m");
  });
});

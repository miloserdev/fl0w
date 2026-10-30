import { registry } from "@fl0w/blocks";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

/**
 * Source → Branch(x == 1) → true: Merge.in0, false: Merge.in1; ещё Source2 → Merge.in2.
 * Ветка «false» не идёт, поэтому вход in1 остаётся пустым.
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
  it("по умолчанию (all) ждёт все подключённые входы: если ветка не пошла, Merge не запускается", async () => {
    const r = await run(f({ mode: "array" }));
    expect(r.started).not.toContain("m");
    expect(r.done?.result).toBeUndefined();
  });

  it("any запускается по пришедшим входам и пропускает не пошедшую ветку", async () => {
    const r = await run(f({ mode: "object", wait: "any" }));
    expect(r.started).toContain("m");
    expect(r.done?.result).toEqual({ in0: { x: 1 }, in2: { y: 2 } });
  });

  it("any: другая сторона ветки — приходит in1 вместо in0; array собирает по номерам портов", async () => {
    const r = await run(f({ mode: "array", wait: "any" }, 5));
    expect(r.done?.result).toEqual([{ x: 5 }, { y: 2 }]);
  });

  it("any, но ни один вход не пришёл — Merge не запускается", async () => {
    const none = flow(
      [node("s", "source", { json: { x: 5 } }), node("b", "branch", { field: "x", operator: "eq", value: 1 }), node("m", "merge", { wait: "any" }), node("r", "result")],
      [edge("s", "b"), edge("b", "m", "out0", "in0"), edge("m", "r")],
    );
    const r = await run(none);
    expect(r.started).not.toContain("m");
  });

  it("any, когда пришли все входы, ведёт себя как all", async () => {
    const all = flow(
      [node("a", "source", { json: { a: 1 } }), node("b", "source", { json: { b: 2 } }), node("m", "merge", { mode: "assign", wait: "any" }), node("r", "result")],
      [edge("a", "m", "out0", "in0"), edge("b", "m", "out0", "in1"), edge("m", "r")],
    );
    expect((await run(all)).done?.result).toEqual({ a: 1, b: 2 });
  });

  it("неизвестное значение wait считается all (безопасное поведение по умолчанию)", async () => {
    expect((await run(f({ mode: "array", wait: "whatever" }))).started).not.toContain("m");
  });
});

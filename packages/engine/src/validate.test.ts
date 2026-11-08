import { describe, expect, it } from "vitest";
import { toposort } from "./toposort";
import { edge, flow, node, testRegistry } from "./test-helpers";
import { validateFlow } from "./validate";

const codes = (f: unknown) => {
  const r = validateFlow(f, testRegistry);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe("validateFlow", () => {
  it("accepts a correct flow", () => {
    const f = flow(
      [node("a", "source", { json: 1 }), node("t", "transform"), node("r", "result")],
      [edge("a", "t"), edge("t", "r")],
    );
    expect(validateFlow(f, testRegistry).ok).toBe(true);
  });

  it("rejects a non-flow (schema)", () => {
    expect(codes({ version: 2 })).toContain("schema");
    expect(codes(null)).toContain("schema");
  });

  it("rejects an unknown block type", () => {
    expect(codes(flow([node("a", "nope")], []))).toEqual(["unknown_type"]);
    const r = validateFlow(flow([node("a", "nope")], []), testRegistry);
    expect(!r.ok && r.issues[0]).toMatchObject({ nodeId: "a", blockType: "nope" });
  });

  it("rejects a cycle", () => {
    const f = flow(
      [node("a", "transform"), node("b", "transform")],
      [edge("a", "b"), edge("b", "a")],
    );
    const r = validateFlow(f, testRegistry);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toContain("cycle");
      expect(r.issues.find((i) => i.code === "cycle")?.message).toMatch(/a, b/);
      expect(r.issues.find((i) => i.code === "cycle")?.nodeIds).toEqual(["a", "b"]);
    }
  });

  it("rejects a self-loop", () => {
    expect(codes(flow([node("a", "transform")], [edge("a", "a")]))).toContain("cycle");
  });

  it("rejects nonexistent ports", () => {
    const f = flow(
      [node("a", "source", { json: 1 }), node("r", "result")],
      [edge("a", "r", "out9", "in0"), edge("a", "r", "out0", "in9", "e2")],
    );
    expect(codes(f).filter((c) => c === "unknown_port")).toHaveLength(2);
  });

  it("a source port cannot be an input, and vice versa", () => {
    const f = flow([node("a", "source", { json: 1 }), node("r", "result")], [edge("a", "r", "in0", "in0")]);
    expect(codes(f)).toContain("unknown_port");
  });

  it("takes portsOverride into account", () => {
    const t = { ...node("t", "transform"), portsOverride: { inputs: [{ id: "in1" }], outputs: [] } };
    const f = flow([node("a", "source", { json: 1 }), t], [edge("a", "t", "out0", "in1")]);
    expect(codes(f)).toEqual([]);
  });

  it("rejects an edge to a nonexistent node", () => {
    expect(codes(flow([node("a", "source", { json: 1 })], [edge("a", "ghost")]))).toContain("unknown_node");
  });

  it("at most one edge into a single input port", () => {
    const f = flow(
      [node("a", "source", { json: 1 }), node("b", "source", { json: 2 }), node("r", "result")],
      [edge("a", "r"), edge("b", "r")],
    );
    expect(codes(f)).toEqual(["port_occupied"]);
  });

  it("rejects duplicate node and edge ids", () => {
    const dupNodes = flow([node("a", "result"), node("a", "result")], []);
    expect(codes(dupNodes)).toContain("duplicate_node");
    const dupEdges = flow(
      [node("a", "source", { json: 1 }), node("t", "transform"), node("u", "transform")],
      [edge("a", "t", "out0", "in0", "e"), edge("a", "u", "out0", "in0", "e")],
    );
    expect(codes(dupEdges)).toContain("duplicate_edge");
  });

  it("checks params: required, type, enum", () => {
    const missing = flow([{ ...node("a", "source"), params: { json: null } }], []);
    expect(codes(missing)).toEqual(["param_required"]);
    const badEnum = flow([node("t", "transform", { mode: "zzz" })], []);
    expect(codes(badEnum)).toEqual(["param_enum"]);
    const badType = flow([node("t", "transform", { mode: 5 })], []);
    expect(codes(badType)).toEqual(["param_enum"]);
  });

  it("default satisfies required", () => {
    expect(codes(flow([node("a", "source", {})], []))).toEqual([]);
  });

  it("issue carries nodeId/edgeId for highlighting in the UI", () => {
    const r = validateFlow(flow([node("t", "transform", { mode: "zzz" })], []), testRegistry);
    expect(!r.ok && r.issues[0]).toMatchObject({ code: "param_enum", nodeId: "t", param: "mode" });
  });
});

describe("toposort", () => {
  it("orders by dependencies", () => {
    const f = flow(
      [node("c", "result"), node("b", "transform"), node("a", "source", { json: 1 })],
      [edge("a", "b"), edge("b", "c")],
    );
    const r = toposort(f);
    expect(r).toEqual({ ok: true, order: ["a", "b", "c"] });
  });

  it("is deterministic for independent nodes", () => {
    const f = flow([node("x", "source"), node("y", "source"), node("z", "source")], []);
    expect(toposort(f)).toEqual({ ok: true, order: ["x", "y", "z"] });
  });

  it("finds a cycle", () => {
    const f = flow(
      [node("s", "source"), node("a", "transform"), node("b", "transform")],
      [edge("s", "a"), edge("a", "b"), edge("b", "a", "out0", "in1")],
    );
    expect(toposort(f)).toEqual({ ok: false, cycle: ["a", "b"] });
  });
});

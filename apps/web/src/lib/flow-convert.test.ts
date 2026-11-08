import { describe, expect, it } from "vitest";
import { collectSeeds, edgeClassFor, flowFingerprint, fromReactFlow, nodePortKind, parsePin, sameStructure, splitPorts, toReactFlow } from "./flow-convert";
import type { Flow } from "@fl0w/schema";

describe("splitPorts", () => {
  it("splits ports into data and resource ones", () => {
    const r = splitPorts({
      inputs: [{ id: "in0" }, { id: "tools", kind: "tool", multiple: true }, { id: "memory", kind: "memory" }],
      outputs: [{ id: "out0", kind: "data" }, { id: "tool", kind: "tool" }],
    });
    expect(r.dataIn.map((p) => p.id)).toEqual(["in0"]);
    expect(r.resourceIn.map((p) => p.id)).toEqual(["tools", "memory"]);
    expect(r.dataOut.map((p) => p.id)).toEqual(["out0"]);
    expect(r.resourceOut.map((p) => p.id)).toEqual(["tool"]);
  });
});

describe("nodePortKind / edgeClassFor", () => {
  it("determines the port kind of a real block", () => {
    expect(nodePortKind("code_agent", null, "inputs", "tools")).toBe("tool");
    expect(nodePortKind("code_agent", null, "inputs", "in0")).toBe("data");
    expect(nodePortKind("code_agent", null, "inputs", "nope")).toBeNull();
    expect(nodePortKind("no_such_block", null, "inputs", "in0")).toBeNull();
  });
  it("dashed only for resource ones", () => {
    expect(edgeClassFor("data")).toBeUndefined();
    expect(edgeClassFor(null)).toBeUndefined();
    expect(edgeClassFor("memory")).toContain("fl-edge-resource");
  });
});

describe("toReactFlow", () => {
  it("sets className on resource edges", () => {
    const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null });
    const flow = {
      version: 1,
      id: "f",
      name: "f",
      nodes: [node("a", "code_agent"), node("t", "tool_calculator"), node("m", "memory_bank"), node("s", "source")],
      edges: [
        { id: "e1", source: "s", sourcePort: "out0", target: "a", targetPort: "in0" },
        { id: "e2", source: "t", sourcePort: "tool", target: "a", targetPort: "tools" },
        { id: "e3", source: "m", sourcePort: "memory", target: "a", targetPort: "memory" },
      ],
    } as unknown as Flow;
    const { edges } = toReactFlow(flow);
    expect(edges[0]!.className).toBeUndefined();
    expect(edges[1]!.className).toContain("fl-edge-tool");
    expect(edges[2]!.className).toContain("fl-edge-memory");
  });
});

describe("pin data and restart", () => {
  it("pinData passes through Flow ↔ React Flow without loss; without pinning the field is not written", () => {
    const flow = {
      version: 1 as const,
      id: "f",
      name: "n",
      nodes: [
        { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null, pinData: { out0: { x: 1 } } },
        { id: "b", type: "result", position: { x: 1, y: 1 }, params: {}, portsOverride: null, cssOverride: null },
      ],
      edges: [],
    };
    const rf = toReactFlow(flow);
    expect(rf.nodes[0]!.data.pinData).toEqual({ out0: { x: 1 } });
    const back = fromReactFlow(rf.nodes, rf.edges, { id: "f", name: "n" });
    expect(back.nodes[0]).toMatchObject({ pinData: { out0: { x: 1 } } });
    expect(back.nodes[1]).not.toHaveProperty("pinData");
  });

  it("disabled passes through Flow ↔ React Flow; without disabling the field is not written; changes the fingerprint", () => {
    const mk = (disabled?: boolean) => ({
      version: 1 as const,
      id: "f",
      name: "n",
      nodes: [
        { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null, ...(disabled ? { disabled } : {}) },
        { id: "b", type: "result", position: { x: 1, y: 1 }, params: {}, portsOverride: null, cssOverride: null },
      ],
      edges: [],
    });
    const rf = toReactFlow(mk(true));
    expect(rf.nodes[0]!.data.disabled).toBe(true);
    const back = fromReactFlow(rf.nodes, rf.edges, { id: "f", name: "n" });
    expect(back.nodes[0]).toMatchObject({ disabled: true });
    expect(back.nodes[1]).not.toHaveProperty("disabled");
    expect(flowFingerprint(mk(true))).not.toBe(flowFingerprint(mk()));
  });

  it("pinning does not make a published flow \"changed\"", () => {
    const base = { version: 1 as const, id: "f", name: "n", edges: [] };
    const node = { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null };
    expect(flowFingerprint({ ...base, nodes: [node] })).toBe(flowFingerprint({ ...base, nodes: [{ ...node, pinData: { out0: 1 } }] }));
  });

  it("collectSeeds takes only outputs; parsePin requires an object", () => {
    expect(collectSeeds({ a: { output: { out0: 1 } }, b: {}, c: { output: {} } })).toEqual({ a: { out0: 1 }, c: {} });
    expect(parsePin('{"out0": {"a": 1}}')).toEqual({ ok: true, value: { out0: { a: 1 } } });
    for (const bad of ["[1]", "5", "null", "{oops", ""]) expect(parsePin(bad).ok, bad).toBe(false);
  });
});

describe("decoration blocks", () => {
  const mk = (type: string, params: Record<string, number | string | boolean>) => ({
    version: 1 as const,
    id: "f",
    name: "f",
    nodes: [{ id: "n1", type, position: { x: 10, y: 20 }, params, portsOverride: null, cssOverride: null }],
    edges: [],
  });

  it("size from params goes into the node and returns back after stretching", () => {
    const rf = toReactFlow(mk("note", { text: "hi", color: "pink", width: 300, height: 100 }));
    const node = rf.nodes[0]!;
    expect(node.type).toBe("layout-note");
    expect([node.width, node.height]).toEqual([300, 100]);
    // the user stretched the node
    const back = fromReactFlow([{ ...node, width: 410.4, height: 222 }], [], { id: "f", name: "f" });
    expect(back.nodes[0]!.params).toEqual({ text: "hi", color: "pink", width: 410, height: 222 });
  });
  it("group and note get a negative zIndex (under the blocks) and their own type; a block gets no size in params", () => {
    expect(toReactFlow(mk("group", { title: "A" })).nodes[0]).toMatchObject({ type: "layout-group", zIndex: -2, width: 420, height: 260 });
    expect(toReactFlow(mk("group", { locked: true })).nodes[0]!.draggable).toBe(false);
    expect(toReactFlow(mk("group", {})).nodes[0]!.draggable).toBeUndefined();
    expect(toReactFlow(mk("note", { text: "t" })).nodes[0]).toMatchObject({ type: "layout-note", zIndex: -1, width: 220, height: 140 });
    const block = toReactFlow(mk("noop", {})).nodes[0]!;
    expect(block.type).toBe("block");
    expect(fromReactFlow([block], [], { id: "f", name: "f" }).nodes[0]!.params).toEqual({});
  });
});

describe("flow fingerprint and decoration", () => {
  it("editing a note or group does not change the fingerprint, editing a block does", () => {
    const base = { version: 1 as const, id: "f", name: "n", edges: [] };
    const block = { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null };
    const note = { id: "n1", type: "note", position: { x: 0, y: 0 }, params: { text: "a", width: 220, height: 140 }, portsOverride: null, cssOverride: null };
    const one = flowFingerprint({ ...base, nodes: [block, note] });
    expect(flowFingerprint({ ...base, nodes: [block, { ...note, params: { text: "b", width: 300, height: 200 } }] })).toBe(one);
    expect(flowFingerprint({ ...base, nodes: [block] })).toBe(one);
    expect(flowFingerprint({ ...base, nodes: [{ ...block, params: { json: 1 } }, note] })).not.toBe(one);
  });
});

describe("ports depending on parameters (outgoing call)", () => {
  it("the err port exists only in await mode; port kind and edge class take parameters into account", async () => {
    const { getPorts, nodePortKind } = await import("./flow-convert");
    const ids = (params: Record<string, unknown>) => getPorts("run_flow", null, params as never).outputs.map((p) => p.id);
    expect(ids({})).toEqual(["out0", "err"]); // await by default
    expect(ids({ mode: "await" })).toEqual(["out0", "err"]);
    expect(ids({ mode: "shoot" })).toEqual(["out0"]);
    expect(nodePortKind("run_flow", null, "outputs", "err", { mode: "await" })).toBe("data");
    expect(nodePortKind("run_flow", null, "outputs", "err", { mode: "shoot" })).toBeNull();
  });
});

describe("sameStructure (dragging must not trigger validation again)", () => {
  const flow: Flow = {
    version: 1,
    id: "f",
    name: "n",
    nodes: [
      { id: "a", type: "source", position: { x: 0, y: 0 }, params: { json: {} }, portsOverride: null, cssOverride: null },
      { id: "b", type: "result", position: { x: 1, y: 1 }, params: {}, portsOverride: null, cssOverride: null },
    ],
    edges: [{ id: "e", source: "a", sourcePort: "out0", target: "b", targetPort: "in0" }],
  };
  const rf = () => toReactFlow(flow);

  it("change of position, selection and size — the same structure", () => {
    const a = rf();
    const moved = { nodes: a.nodes.map((n) => ({ ...n, position: { x: 99, y: 99 }, selected: true, width: 5 })), edges: a.edges.map((e) => ({ ...e })) };
    expect(sameStructure(a, moved)).toBe(true);
  });

  it("editing params, adding a node and changing a connection — a different structure", () => {
    const a = rf();
    expect(sameStructure(a, { nodes: a.nodes.map((n, i) => (i === 0 ? { ...n, data: { ...n.data, params: { json: { x: 1 } } } } : n)), edges: a.edges })).toBe(false);
    expect(sameStructure(a, { nodes: a.nodes.slice(0, 1), edges: a.edges })).toBe(false);
    expect(sameStructure(a, { nodes: a.nodes, edges: a.edges.map((e) => ({ ...e, targetHandle: "in1" })) })).toBe(false);
  });
});

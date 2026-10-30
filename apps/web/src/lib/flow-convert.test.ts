import { describe, expect, it } from "vitest";
import { collectSeeds, edgeClassFor, flowFingerprint, fromReactFlow, nodePortKind, parsePin, splitPorts, toReactFlow } from "./flow-convert";
import type { Flow } from "@fl0w/schema";

describe("splitPorts", () => {
  it("делит порты на данные и ресурсные", () => {
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
  it("определяет вид порта у реального блока", () => {
    expect(nodePortKind("code_agent", null, "inputs", "tools")).toBe("tool");
    expect(nodePortKind("code_agent", null, "inputs", "in0")).toBe("data");
    expect(nodePortKind("code_agent", null, "inputs", "nope")).toBeNull();
    expect(nodePortKind("no_such_block", null, "inputs", "in0")).toBeNull();
  });
  it("пунктир только у ресурсных", () => {
    expect(edgeClassFor("data")).toBeUndefined();
    expect(edgeClassFor(null)).toBeUndefined();
    expect(edgeClassFor("memory")).toContain("fl-edge-resource");
  });
});

describe("toReactFlow", () => {
  it("проставляет className ресурсным рёбрам", () => {
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

describe("pin data и перезапуск", () => {
  it("pinData проходит через Flow ↔ React Flow без потерь; без закрепления поле не пишется", () => {
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

  it("закрепление не делает опубликованный флоу «изменённым»", () => {
    const base = { version: 1 as const, id: "f", name: "n", edges: [] };
    const node = { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null };
    expect(flowFingerprint({ ...base, nodes: [node] })).toBe(flowFingerprint({ ...base, nodes: [{ ...node, pinData: { out0: 1 } }] }));
  });

  it("collectSeeds берёт только выходы; parsePin требует объект", () => {
    expect(collectSeeds({ a: { output: { out0: 1 } }, b: {}, c: { output: {} } })).toEqual({ a: { out0: 1 }, c: {} });
    expect(parsePin('{"out0": {"a": 1}}')).toEqual({ ok: true, value: { out0: { a: 1 } } });
    for (const bad of ["[1]", "5", "null", "{oops", ""]) expect(parsePin(bad).ok, bad).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { edgeClassFor, nodePortKind, splitPorts, toReactFlow } from "./flow-convert";
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

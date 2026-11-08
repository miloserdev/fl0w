import { describe, expect, it } from "vitest";
import type { Flow } from "@fl0w/schema";
import { CLIP_MARK, parseClipboard, pasteNodes, serializeSelection } from "./clipboard";
import { toReactFlow } from "./flow-convert";

const flow: Flow = {
  version: 1,
  id: "f",
  name: "f",
  nodes: [
    { id: "a", type: "manual", position: { x: 100, y: 100 }, params: {}, portsOverride: null, cssOverride: null },
    { id: "b", type: "wait", position: { x: 300, y: 100 }, params: { amount: 2, unit: "seconds" }, portsOverride: null, cssOverride: null, disabled: true, pinData: { out0: { x: 1 } } },
    { id: "c", type: "result", position: { x: 500, y: 100 }, params: {}, portsOverride: null, cssOverride: null },
  ],
  edges: [
    { id: "e1", source: "a", sourcePort: "out0", target: "b", targetPort: "in0" },
    { id: "e2", source: "b", sourcePort: "out0", target: "c", targetPort: "in0" },
  ],
};
const select = (ids: string[]) => {
  const rf = toReactFlow(flow);
  return { nodes: rf.nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })), edges: rf.edges };
};

describe("node clipboard", () => {
  it("copies the selection and only the edges between selected nodes", () => {
    const { nodes, edges } = select(["a", "b"]);
    const text = serializeSelection(nodes, edges)!;
    const clip = parseClipboard(text)!;
    expect(clip.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(clip.edges.map((e) => e.id)).toEqual(["e1"]); // e2 goes to the unselected c
    expect(clip.nodes[1]).toMatchObject({ disabled: true, pinData: { out0: { x: 1 } }, params: { amount: 2, unit: "seconds" } });
  });

  it("no selection — nothing is copied", () => {
    const { nodes, edges } = select([]);
    expect(serializeSelection(nodes, edges)).toBeNull();
  });

  it("foreign text, broken JSON, an unknown block and huge input are rejected", () => {
    expect(parseClipboard("просто текст")).toBeNull();
    expect(parseClipboard(`{"${CLIP_MARK}":1,`)).toBeNull();
    expect(parseClipboard(JSON.stringify({ [CLIP_MARK]: 1, nodes: [{ id: "x", type: "no_such_block", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null }], edges: [] }))).toBeNull();
    expect(parseClipboard(JSON.stringify({ [CLIP_MARK]: 2, nodes: flow.nodes, edges: [] }))).toBeNull();
    expect(parseClipboard(JSON.stringify({ [CLIP_MARK]: 1, nodes: [], edges: [] }))).toBeNull();
    expect(parseClipboard(`${CLIP_MARK}${"x".repeat(5_000_001)}`)).toBeNull();
  });

  it("paste: new ids, edges reconnected, only the new ones selected, the copy offset from the original", () => {
    const { nodes, edges } = select(["a", "b"]);
    const clip = parseClipboard(serializeSelection(nodes, edges)!)!;
    const pasted = pasteNodes(clip, nodes);
    expect(pasted.nodes).toHaveLength(2);
    expect(pasted.nodes.every((n) => n.selected)).toBe(true);
    expect(new Set(pasted.nodes.map((n) => n.id)).size).toBe(2);
    expect(pasted.nodes.some((n) => ["a", "b"].includes(n.id))).toBe(false);
    expect(pasted.nodes[0]!.position).toEqual({ x: 140, y: 140 }); // the original at (100,100) is occupied
    expect(pasted.edges).toHaveLength(1);
    expect(pasted.edges[0]).toMatchObject({ source: pasted.nodes[0]!.id, target: pasted.nodes[1]!.id });
    expect(pasted.nodes[1]!.data).toMatchObject({ disabled: true, pinData: { out0: { x: 1 } } });
  });

  it("paste into an empty canvas keeps the position; a repeated paste goes even further", () => {
    const { nodes, edges } = select(["a"]);
    const clip = parseClipboard(serializeSelection(nodes, edges)!)!;
    const first = pasteNodes(clip, []);
    expect(first.nodes[0]!.position).toEqual({ x: 100, y: 100 });
    const second = pasteNodes(clip, first.nodes);
    expect(second.nodes[0]!.position).toEqual({ x: 140, y: 140 });
    const third = pasteNodes(clip, [...first.nodes, ...second.nodes]);
    expect(third.nodes[0]!.position).toEqual({ x: 180, y: 180 });
  });
});

import { flowSchema, type Flow } from "@fl0w/schema";
import { registry } from "@fl0w/blocks";
import type { Edge } from "@xyflow/react";
import { fromReactFlow, newNodeId, toReactFlow, type BlockNodeType } from "./flow-convert";

/** Format marker in the clipboard: foreign text is ignored on paste. */
export const CLIP_MARK = "fl0w-clipboard";
const MAX_CLIP_CHARS = 5_000_000;
const MAX_CLIP_NODES = 500;
const OFFSET = 40;

/** Selected nodes and the edges between them → text for the system clipboard (JSON). No selection — null. */
export function serializeSelection(nodes: BlockNodeType[], edges: Edge[]): string | null {
  const picked = nodes.filter((n) => n.selected);
  if (picked.length === 0) return null;
  const ids = new Set(picked.map((n) => n.id));
  const flow = fromReactFlow(picked, edges.filter((e) => ids.has(e.source) && ids.has(e.target)), { id: "clip", name: "clip" });
  return JSON.stringify({ [CLIP_MARK]: 1, nodes: flow.nodes, edges: flow.edges });
}

/** Parsing text from the clipboard: a valid set of nodes of known blocks or null (not our format, broken, too large). */
export function parseClipboard(text: string): Flow | null {
  if (text.length > MAX_CLIP_CHARS || !text.includes(CLIP_MARK)) return null;
  try {
    const raw = JSON.parse(text) as { nodes?: unknown; edges?: unknown } & Record<string, unknown>;
    if (raw[CLIP_MARK] !== 1) return null;
    const parsed = flowSchema.safeParse({ version: 1, id: "clip", name: "clip", nodes: raw.nodes, edges: raw.edges });
    if (!parsed.success) return null;
    const f = parsed.data;
    if (f.nodes.length === 0 || f.nodes.length > MAX_CLIP_NODES || !f.nodes.every((n) => registry[n.type])) return null;
    return f;
  } catch {
    return null;
  }
}

/**
 * Paste: new node and edge ids, an offset so the copy does not lie exactly on top of existing ones, only the pasted ones are selected.
 * Pinned data and the "disabled" flag are copied together with the node.
 */
export function pasteNodes(clip: Flow, existing: BlockNodeType[]): { nodes: BlockNodeType[]; edges: Edge[] } {
  const idMap = new Map(clip.nodes.map((n) => [n.id, newNodeId(n.type)]));
  const rf = toReactFlow({ ...clip, nodes: clip.nodes.map((n) => ({ ...n, id: idMap.get(n.id)! })), edges: clip.edges.map((e) => ({ ...e, id: `e_${Math.random().toString(36).slice(2, 8)}`, source: idMap.get(e.source)!, target: idMap.get(e.target)! })) });
  const taken = new Set(existing.map((n) => `${Math.round(n.position.x)},${Math.round(n.position.y)}`));
  const first = rf.nodes[0]!.position;
  let shift = 0;
  while (taken.has(`${Math.round(first.x + shift)},${Math.round(first.y + shift)}`)) shift += OFFSET;
  return {
    nodes: rf.nodes.map((n) => ({ ...n, selected: true, position: { x: n.position.x + shift, y: n.position.y + shift } })),
    edges: rf.edges,
  };
}

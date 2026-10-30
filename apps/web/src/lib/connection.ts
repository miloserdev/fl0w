import type { Edge } from "@xyflow/react";
import { getPorts, nodePortKind, type BlockNodeType } from "./flow-convert";

/** true, если из `from` по рёбрам можно дойти до `to` (нужно для запрета циклов). */
export function reaches(edges: Edge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return false;
}

type Conn = { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };

/**
 * Можно ли провести ребро: порты существуют и одного вида; порт без `multiple` принимает одно ребро;
 * граф данных остаётся DAG (ресурсные рёбра на циклы не проверяются).
 */
export function canConnect(nodes: Pick<BlockNodeType, "id" | "data">[], edges: Edge[], c: Conn): boolean {
  if (c.source === c.target) return false;
  const src = nodes.find((n) => n.id === c.source);
  const dst = nodes.find((n) => n.id === c.target);
  if (!src || !dst) return false;
  const from = nodePortKind(src.data.blockType, src.data.portsOverride, "outputs", c.sourceHandle);
  const to = nodePortKind(dst.data.blockType, dst.data.portsOverride, "inputs", c.targetHandle);
  if (!from || from !== to) return false;
  const port = getPorts(dst.data.blockType, dst.data.portsOverride).inputs.find((p) => p.id === c.targetHandle);
  if (!port?.multiple && edges.some((e) => e.target === c.target && e.targetHandle === c.targetHandle)) return false;
  if (edges.some((e) => e.source === c.source && e.sourceHandle === c.sourceHandle && e.target === c.target && e.targetHandle === c.targetHandle)) return false;
  if (from !== "data") return true;
  const dataEdges = edges.filter((e) => nodePortKindOfEdge(nodes, e) === "data");
  return !reaches(dataEdges, c.target, c.source);
}

function nodePortKindOfEdge(nodes: Pick<BlockNodeType, "id" | "data">[], e: Edge) {
  const n = nodes.find((x) => x.id === e.source);
  return n ? nodePortKind(n.data.blockType, n.data.portsOverride, "outputs", e.sourceHandle) : null;
}


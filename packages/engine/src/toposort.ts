import type { Flow } from "@fl0w/schema";

export type TopoResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] };

/**
 * Алгоритм Кана. Порядок детерминирован: среди готовых нод берём в порядке объявления в `flow.nodes`.
 * При цикле возвращает id нод, которые в него входят или от него зависят.
 */
export function toposort(flow: Pick<Flow, "nodes" | "edges">): TopoResult {
  const ids = new Set(flow.nodes.map((n) => n.id));
  const indegree = new Map<string, number>(flow.nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const e of flow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
  }

  const queue = flow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length === ids.size) return { ok: true, order };
  const done = new Set(order);
  return { ok: false, cycle: flow.nodes.map((n) => n.id).filter((id) => !done.has(id)) };
}

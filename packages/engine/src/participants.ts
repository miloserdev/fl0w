import { getNodePorts } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import type { Registry } from "./validate";

function closure(from: Iterable<string>, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return seen;
}

/** Блок без входных портов, не триггер: источник данных (Source). */
export function isDataSource(flow: Flow, registry: Registry, nodeId: string): boolean {
  const node = flow.nodes.find((n) => n.id === nodeId);
  const cls = node && registry[node.type];
  return !!cls && !cls.isTrigger && getNodePorts(cls, node.portsOverride).inputs.length === 0;
}

/**
 * Какие ноды вообще участвуют в запуске. Запуск идёт от СТАРТОВЫХ нод:
 *  - если во флоу есть триггеры — это триггеры (`trigger` сужает до одного, как при плановом запуске);
 *  - иначе — источники данных (блоки без входов, например Source).
 * Участвуют стартовые ноды, всё, что достижимо от них по рёбрам, и всё, что питает достижимое
 * (второй вход Compare Datasets может идти от Source, не связанного с триггером напрямую).
 * Остальное — ноды без связи со стартом — не запускается, даже если у них нет подключённых входов.
 */
export function participatingNodes(flow: Flow, registry: Registry, trigger?: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of flow.edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }

  const triggers = flow.nodes.filter((n) => registry[n.type]?.isTrigger).map((n) => n.id);
  const starts =
    triggers.length > 0
      ? trigger !== undefined
        ? [trigger]
        : triggers
      : flow.nodes.filter((n) => isDataSource(flow, registry, n.id)).map((n) => n.id);

  const reached = closure(starts, (id) => outgoing.get(id) ?? []);
  return closure(reached, (id) => incoming.get(id) ?? []);
}

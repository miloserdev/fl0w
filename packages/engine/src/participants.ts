import { getNodePorts } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import { edgeKind } from "./resources";
import type { Registry } from "./validate";

export function closure(from: Iterable<string>, next: (id: string) => string[]): Set<string> {
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
  return !!cls && !cls.resource && !cls.layout && !cls.isTrigger && getNodePorts(cls, node.portsOverride, node.params).inputs.length === 0;
}

/**
 * Какие ноды вообще участвуют в запуске. Запуск идёт от СТАРТОВЫХ нод:
 *  - если во флоу есть триггеры — это триггеры (`trigger` сужает до одного, как при плановом запуске; без `trigger` —
 *    только те, что не ждут внешнего события: у вебхука, файла, Telegram нет данных, и ручной запуск их не стартует);
 *  - иначе — источники данных (блоки без входов, например Source).
 * Участвуют стартовые ноды, всё, что достижимо от них по рёбрам, и всё, что питает достижимое
 * (второй вход Compare Datasets может идти от Source, не связанного с триггером напрямую).
 * Остальное — ноды без связи со стартом — не запускается, даже если у них нет подключённых входов.
 */
export function startNodes(flow: Flow, registry: Registry, trigger?: string): string[] {
  const triggers = flow.nodes.filter((n) => registry[n.type]?.isTrigger).map((n) => n.id);
  if (triggers.length === 0) return flow.nodes.filter((n) => isDataSource(flow, registry, n.id)).map((n) => n.id);
  if (trigger !== undefined) return [trigger];
  // ручной запуск: триггеры, ждущие внешнего события (вебхук, файл, Telegram…), не стартуют — кроме закреплённых
  // триггер события с закреплёнными данными (pin) стартует: закреплённый «запрос» заменяет настоящее событие
  return triggers.filter((id) => {
    const n = flow.nodes.find((x) => x.id === id)!;
    const cls = registry[n.type];
    if (cls?.callOnly) return false; // phone-incoming поднимается только вызовом — даже закреплённые данные его не запускают
    return !cls?.eventDriven || !!n.pinData;
  });
}

export function participatingNodes(flow: Flow, registry: Registry, trigger?: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (edgeKind(flow, registry, e) !== "data") continue; // инструменты и память не передают данные
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }

  const starts = startNodes(flow, registry, trigger);
  const reached = closure(starts, (id) => outgoing.get(id) ?? []);
  return closure(reached, (id) => incoming.get(id) ?? []);
}

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

/** A block with no input ports that is not a trigger: a data source (Source). */
export function isDataSource(flow: Flow, registry: Registry, nodeId: string): boolean {
  const node = flow.nodes.find((n) => n.id === nodeId);
  const cls = node && registry[node.type];
  return !!cls && !node?.disabled && !cls.resource && !cls.layout && !cls.isTrigger && getNodePorts(cls, node.portsOverride, node.params).inputs.length === 0;
}

/**
 * Which nodes take part in the run at all. A run starts from START nodes:
 *  - if the flow has triggers, these are the triggers (`trigger` narrows to one, as in a scheduled run; without `trigger`,
 *    only those that do not wait for an external event: a webhook, file or Telegram has no data, and a manual run does not start them);
 *  - otherwise data sources (blocks without inputs, e.g. Source).
 * The participants are the start nodes, everything reachable from them along edges, and everything that feeds the reachable ones
 * (the second input of Compare Datasets may come from a Source not linked to the trigger directly).
 * The rest, nodes with no link to the start, do not run even if they have no connected inputs.
 */
export function startNodes(flow: Flow, registry: Registry, trigger?: string): string[] {
  const triggers = flow.nodes.filter((n) => registry[n.type]?.isTrigger && !n.disabled).map((n) => n.id);
  if (triggers.length === 0) return flow.nodes.filter((n) => isDataSource(flow, registry, n.id)).map((n) => n.id);
  if (trigger !== undefined) return [trigger];
  // manual run: triggers waiting for an external event (webhook, file, Telegram…) do not start, except pinned ones
  // an event trigger with pinned data starts: the pinned "request" replaces the real event
  return triggers.filter((id) => {
    const n = flow.nodes.find((x) => x.id === id)!;
    const cls = registry[n.type];
    if (cls?.callOnly) return false; // an incoming call is raised only by a call; even pinned data does not start it
    return !cls?.eventDriven || !!n.pinData;
  });
}

export function participatingNodes(flow: Flow, registry: Registry, trigger?: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (edgeKind(flow, registry, e) !== "data") continue; // tools and memory do not pass data
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }

  const starts = startNodes(flow, registry, trigger);
  const reached = closure(starts, (id) => outgoing.get(id) ?? []);
  return closure(reached, (id) => incoming.get(id) ?? []);
}

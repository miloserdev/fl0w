import type { Flow } from "@fl0w/schema";

/** Типы блоков пары вызовов: исходящий (`run_flow`) и входящий (`call_trigger`) телефоны. */
export const CALL_OUT = "run_flow";
export const CALL_IN = "call_trigger";

export type CallEnd = { nodeId: string; channelId: string };

/** Каналы флоу: что на нём висит входящими и исходящими телефонами (канал — параметр `channelId`, пробелы по краям не значимы). */
export function channelsOf(flow: Pick<Flow, "nodes">): { incoming: CallEnd[]; outgoing: CallEnd[] } {
  const incoming: CallEnd[] = [];
  const outgoing: CallEnd[] = [];
  for (const n of flow.nodes) {
    if (n.type !== CALL_IN && n.type !== CALL_OUT) continue;
    const channelId = typeof n.params["channelId"] === "string" ? n.params["channelId"].trim() : "";
    if (channelId === "") continue; // пустой канал — ошибка параметра, её даёт обычная проверка
    (n.type === CALL_IN ? incoming : outgoing).push({ nodeId: n.id, channelId });
  }
  return { incoming, outgoing };
}

/**
 * Флоу и триггер, на которые ведёт канал: ровно один incoming call среди `flows`. Нет ни одного или больше одного — бросает
 * с понятной причиной (связь строго 1:1).
 */
export function findIncoming(flows: Flow[], channelId: string): { flow: Flow; triggerId: string } {
  const found: { flow: Flow; triggerId: string }[] = [];
  for (const flow of flows) {
    for (const end of channelsOf(flow).incoming) if (end.channelId === channelId.trim()) found.push({ flow, triggerId: end.nodeId });
  }
  if (found.length === 0) throw new Error(`No incoming call with channel "${channelId}" (the callee flow must have one, and be saved/published)`);
  if (found.length > 1) {
    throw new Error(`Channel "${channelId}" is ambiguous: ${found.length} incoming call blocks use it (${found.map((f) => `${f.flow.id}/${f.triggerId}`).join(", ")}) — a channel connects exactly one pair`);
  }
  return found[0]!;
}

export type CallIssue = { code: "call_channel"; message: string; nodeId?: string; channelId: string };

/**
 * Связь 1:1: на канале не более одного входящего и не более одного исходящего телефона — внутри флоу и среди остальных флоу
 * (`others`). Отсутствие пары не ошибка: вызывающий может быть создан раньше вызываемого.
 */
export function validateCallChannels(flow: Pick<Flow, "id" | "nodes">, others: Pick<Flow, "id" | "nodes">[] = []): CallIssue[] {
  const issues: CallIssue[] = [];
  const mine = channelsOf(flow);
  const seen = { incoming: new Map<string, string>(), outgoing: new Map<string, string>() };
  for (const side of ["incoming", "outgoing"] as const) {
    for (const end of mine[side]) {
      const dup = seen[side].get(end.channelId);
      if (dup !== undefined) {
        issues.push({ code: "call_channel", nodeId: end.nodeId, channelId: end.channelId, message: `Channel "${end.channelId}" is used by two ${side} calls in this flow ("${dup}" and "${end.nodeId}") — a channel connects exactly one pair` });
      } else seen[side].set(end.channelId, end.nodeId);
      for (const other of others) {
        if (other.id === flow.id) continue;
        const clash = channelsOf(other)[side].find((e) => e.channelId === end.channelId);
        if (clash) {
          issues.push({ code: "call_channel", nodeId: end.nodeId, channelId: end.channelId, message: `Channel "${end.channelId}" already has an ${side === "incoming" ? "incoming" : "outgoing"} call in flow "${other.id}" — a channel connects exactly one pair` });
        }
      }
    }
  }
  return issues;
}

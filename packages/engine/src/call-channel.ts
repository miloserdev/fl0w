import type { Flow } from "@fl0w/schema";

/** Call block types: outgoing is Emitter (`run_flow`), incoming is Collector (`call_trigger`). */
export const CALL_OUT = "run_flow";
export const CALL_IN = "call_trigger";

export type CallEnd = { nodeId: string; channelId: string };

/** Flow channels: what hangs on each as incoming and outgoing phones (the channel is the `channelId` parameter, surrounding whitespace is not significant). */
export function channelsOf(flow: Pick<Flow, "nodes">): { incoming: CallEnd[]; outgoing: CallEnd[] } {
  const incoming: CallEnd[] = [];
  const outgoing: CallEnd[] = [];
  for (const n of flow.nodes) {
    if (n.disabled || (n.type !== CALL_IN && n.type !== CALL_OUT)) continue; // disabled calls do not belong to channels
    const channelId = typeof n.params["channelId"] === "string" ? n.params["channelId"].trim() : "";
    if (channelId === "") continue; // an empty channel is a parameter error, reported by the regular validation
    (n.type === CALL_IN ? incoming : outgoing).push({ nodeId: n.id, channelId });
  }
  return { incoming, outgoing };
}

/**
 * The flow and trigger a channel leads to: exactly one incoming call among `flows`. If there is none or more than one, throws
 * with a clear reason (strictly 1:1).
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
 * 1:1 link: a channel has at most one incoming and at most one outgoing phone, both inside the flow and among the other flows
 * (`others`). A missing pair is not an error: the caller may be created before the callee.
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

/**
 * Flow graphs are connected components (over all edges, including resource ones): blocks on one canvas that are linked together.
 * Returns the component number for each node.
 */
export function graphsOf(flow: Pick<Flow, "nodes" | "edges">): Map<string, number> {
  const parent = new Map(flow.nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = x; c !== r; ) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const e of flow.edges) if (parent.has(e.source) && parent.has(e.target)) parent.set(find(e.source), find(e.target));
  const ids = new Map<string, number>();
  const out = new Map<string, number>();
  for (const n of flow.nodes) {
    const root = find(n.id);
    if (!ids.has(root)) ids.set(root, ids.size);
    out.set(n.id, ids.get(root)!);
  }
  return out;
}

export type CallGraphIssue = { code: "call_same_graph"; message: string; nodeId?: string };

/**
 * Calls must not cause recursion: one graph (linked blocks) cannot contain both an outgoing call (Emitter) and an
 * incoming one (Collector). So a called graph never calls anyone itself, and there are no call chains or cycles. For repetition use the
 * Loop block (a loop with its body in the same graph, unrelated to calls).
 */
export function validateCallGraph(flow: Pick<Flow, "id" | "nodes" | "edges">): CallGraphIssue[] {
  const issues: CallGraphIssue[] = [];
  const graphs = graphsOf(flow);
  const calls = channelsOf(flow);
  for (const out of calls.outgoing) {
    const peer = calls.incoming.find((i) => graphs.get(i.nodeId) === graphs.get(out.nodeId));
    if (peer) {
      issues.push({
        code: "call_same_graph",
        nodeId: out.nodeId,
        message: `Outgoing call "${out.nodeId}" and incoming call "${peer.nodeId}" are in the same graph — a graph cannot call itself (that is recursion). Put them in separate graphs, or use a Loop block to repeat`,
      });
    }
  }
  return issues;
}

import { getNodePorts, portKind, validateParams, type BlockClass } from "@fl0w/blocks";
import { flowSchema, type Flow } from "@fl0w/schema";
import { validateCallChannels, validateCallGraph } from "./call-channel";
import { dataView } from "./resources";
import { toposort } from "./toposort";

export type FlowIssueCode =
  | "schema"
  | "duplicate_node"
  | "duplicate_edge"
  | "unknown_type"
  | "unknown_node"
  | "unknown_port"
  | "port_occupied"
  | "port_kind"
  | "call_channel"
  | "call_same_graph"
  | "loop_body_overlap"
  | "cycle"
  | "param_required"
  | "param_type"
  | "param_enum"
  | "param_range";

/** Structured error: the UI localises by `code`; `message` is a fallback text in English. */
export type FlowIssue = {
  code: FlowIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  port?: string;
  param?: string;
  /** unknown_type: the requested block type. */
  blockType?: string;
  /** cycle: nodes that take part in the cycle or depend on it. */
  nodeIds?: string[];
};

export type ValidationResult =
  | { ok: true; flow: Flow }
  | { ok: false; issues: FlowIssue[] };

export type Registry = Record<string, BlockClass>;

/**
 * Flow validation: zod schema + invariants + DAG.
 * Accepts `unknown` so it suits both a file from disk and an API request body.
 */
export function validateFlow(input: unknown, registry: Registry): ValidationResult {
  const parsed = flowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: "schema" as const,
        message: `${i.path.join(".") || "flow"}: ${i.message}`,
      })),
    };
  }

  const flow = parsed.data;
  const issues: FlowIssue[] = [];
  const nodes = new Map<string, Flow["nodes"][number]>();

  for (const node of flow.nodes) {
    if (nodes.has(node.id)) {
      issues.push({ code: "duplicate_node", nodeId: node.id, message: `Duplicate node id "${node.id}"` });
      continue;
    }
    nodes.set(node.id, node);

    const cls = registry[node.type];
    if (!cls) {
      issues.push({
        code: "unknown_type",
        nodeId: node.id,
        blockType: node.type,
        message: `Node "${node.id}": unknown block type "${node.type}"`,
      });
      continue;
    }
    // a disabled node's parameters are not validated: it can be left unfinished
    for (const p of node.disabled ? [] : validateParams(cls.params, node.params, { allowExpressions: true })) {
      issues.push({
        code: `param_${p.code}`,
        nodeId: node.id,
        param: p.param,
        message: `Node "${node.id}": ${p.message}`,
      });
    }
  }

  const portsOf = (nodeId: string) => {
    const node = nodes.get(nodeId);
    const cls = node && registry[node.type];
    return node && cls ? getNodePorts(cls, node.portsOverride, node.params) : null;
  };

  const seenEdges = new Set<string>();
  const usedInputs = new Set<string>();
  for (const e of flow.edges) {
    if (seenEdges.has(e.id)) {
      issues.push({ code: "duplicate_edge", edgeId: e.id, message: `Duplicate edge id "${e.id}"` });
    }
    seenEdges.add(e.id);

    let ok = true;
    for (const [role, nodeId] of [["source", e.source], ["target", e.target]] as const) {
      if (!nodes.has(nodeId)) {
        ok = false;
        issues.push({
          code: "unknown_node",
          edgeId: e.id,
          nodeId,
          message: `Edge "${e.id}": ${role} node "${nodeId}" does not exist`,
        });
      }
    }
    if (!ok) continue;

    // ports are checked only for nodes with a known type, otherwise the error already exists (unknown_type)
    const src = portsOf(e.source);
    const dst = portsOf(e.target);
    if (src && !src.outputs.some((p) => p.id === e.sourcePort)) {
      issues.push({
        code: "unknown_port",
        edgeId: e.id,
        nodeId: e.source,
        port: e.sourcePort,
        message: `Edge "${e.id}": node "${e.source}" has no output port "${e.sourcePort}"`,
      });
    }
    if (dst && !dst.inputs.some((p) => p.id === e.targetPort)) {
      issues.push({
        code: "unknown_port",
        edgeId: e.id,
        nodeId: e.target,
        port: e.targetPort,
        message: `Edge "${e.id}": node "${e.target}" has no input port "${e.targetPort}"`,
      });
    }

    // only ports of the same kind connect: data to data, tool to tool, memory to memory
    const srcPort = src?.outputs.find((p) => p.id === e.sourcePort);
    const dstPort = dst?.inputs.find((p) => p.id === e.targetPort);
    if (srcPort && dstPort && portKind(srcPort) !== portKind(dstPort)) {
      issues.push({
        code: "port_kind",
        edgeId: e.id,
        nodeId: e.target,
        port: e.targetPort,
        message: `Edge "${e.id}": a ${portKind(srcPort)} output cannot be connected to a ${portKind(dstPort)} input`,
      });
    }

    const key = `${e.target}\u0000${e.targetPort}`;
    if (usedInputs.has(key) && !dstPort?.multiple) {
      issues.push({
        code: "port_occupied",
        edgeId: e.id,
        nodeId: e.target,
        port: e.targetPort,
        message: `Input port "${e.targetPort}" of node "${e.target}" already has an incoming edge`,
      });
    }
    usedInputs.add(key);
  }

  // call pair: one incoming and one outgoing per channel (cross-flow check happens on save on the server)
  for (const p of validateCallChannels(flow)) issues.push({ code: "call_channel", nodeId: p.nodeId, message: p.message });
  // calls do not cause recursion: Emitter/Loop and Collector are not in the same graph
  for (const p of validateCallGraph(flow)) issues.push({ code: p.code, nodeId: p.nodeId, message: p.message });

  // loop: the body (reachable from the `body` port) must not overlap with the continuation after the loop (reachable from the other outputs)
  {
    const data = dataView(flow, registry);
    const out = new Map<string, { port: string; target: string }[]>();
    for (const e of data.edges) out.set(e.source, [...(out.get(e.source) ?? []), { port: e.sourcePort, target: e.target }]);
    const reach = (starts: string[]) => {
      const seen = new Set<string>();
      const stack = [...starts];
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const e of out.get(id) ?? []) stack.push(e.target);
      }
      return seen;
    };
    for (const n of flow.nodes) {
      const bodyPort = registry[n.type]?.bodyPort;
      if (!bodyPort) continue;
      const body = reach((out.get(n.id) ?? []).filter((e) => e.port === bodyPort).map((e) => e.target));
      const after = reach((out.get(n.id) ?? []).filter((e) => e.port !== bodyPort).map((e) => e.target));
      const shared = [...body].filter((id) => after.has(id));
      if (shared.length > 0) {
        issues.push({
          code: "loop_body_overlap",
          nodeId: n.id,
          nodeIds: shared,
          message: `Loop "${n.id}": nodes ${shared.map((s) => `"${s}"`).join(", ")} are reachable both from its body and from its exit — the body must be separate from what follows the loop`,
        });
      }
    }
  }

  const topo = toposort(dataView(flow, registry));
  if (!topo.ok) {
    issues.push({
      code: "cycle",
      nodeIds: topo.cycle,
      message: `Flow contains a cycle (nodes: ${topo.cycle.join(", ")})`,
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true, flow };
}

export function formatIssues(issues: FlowIssue[]): string {
  return issues.map((i) => i.message).join("; ");
}

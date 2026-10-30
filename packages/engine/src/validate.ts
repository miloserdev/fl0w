import { getNodePorts, validateParams, type BlockClass } from "@fl0w/blocks";
import { flowSchema, type Flow } from "@fl0w/schema";
import { toposort } from "./toposort";

export type FlowIssueCode =
  | "schema"
  | "duplicate_node"
  | "duplicate_edge"
  | "unknown_type"
  | "unknown_node"
  | "unknown_port"
  | "port_occupied"
  | "cycle"
  | "param_required"
  | "param_type"
  | "param_enum"
  | "param_range";

/** Структурированная ошибка: UI локализует по `code`, `message` — запасной текст на английском. */
export type FlowIssue = {
  code: FlowIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  port?: string;
  param?: string;
  /** unknown_type: запрошенный тип блока. */
  blockType?: string;
  /** cycle: ноды, участвующие в цикле или зависящие от него. */
  nodeIds?: string[];
};

export type ValidationResult =
  | { ok: true; flow: Flow }
  | { ok: false; issues: FlowIssue[] };

export type Registry = Record<string, BlockClass>;

/**
 * Валидация флоу: zod-схема + инварианты (SPEC §4) + DAG.
 * Принимает `unknown`, чтобы годиться и для файла с диска, и для тела API-запроса.
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
    for (const p of validateParams(cls.params, node.params, { allowExpressions: true })) {
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
    return node && cls ? getNodePorts(cls, node.portsOverride) : null;
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

    // порты проверяем только у нод с известным типом — иначе ошибка уже есть (unknown_type)
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

    const key = `${e.target}\u0000${e.targetPort}`;
    if (usedInputs.has(key)) {
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

  const topo = toposort(flow);
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

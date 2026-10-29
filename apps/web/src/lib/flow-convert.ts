import type { Edge, Node } from "@xyflow/react";
import { getNodePorts, registry } from "@fl0w/blocks";
import type { Flow, FlowNode, Json, PortsDef } from "@fl0w/schema";

export type BlockNodeData = {
  blockType: string;
  params: Record<string, Json>;
  portsOverride: PortsDef | null;
  cssOverride: string | null;
};
export type BlockNodeType = Node<BlockNodeData, "block">;

export type FlowMeta = Pick<Flow, "id" | "name">;

/** Порты инстанса: дефолтные из класса + добавленные через portsOverride. */
export function getPorts(blockType: string, override: PortsDef | null): PortsDef {
  const cls = registry[blockType];
  return cls ? getNodePorts(cls, override) : { inputs: [], outputs: [] };
}

export function defaultParams(blockType: string): Record<string, Json> {
  const params: Record<string, Json> = {};
  for (const p of registry[blockType]?.params ?? []) {
    if (p.default !== undefined) params[p.name] = p.default;
  }
  return params;
}

export function newNodeId(blockType: string): string {
  return `${blockType}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newFlowId(): string {
  return `flow_${Math.random().toString(36).slice(2, 10)}`;
}

export function toReactFlow(flow: Flow): { nodes: BlockNodeType[]; edges: Edge[] } {
  return {
    nodes: flow.nodes.map((n) => ({
      id: n.id,
      type: "block",
      position: n.position,
      data: {
        blockType: n.type,
        params: n.params,
        portsOverride: n.portsOverride,
        cssOverride: n.cssOverride,
      },
    })),
    edges: flow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourcePort,
      target: e.target,
      targetHandle: e.targetPort,
    })),
  };
}

export function fromReactFlow(
  nodes: BlockNodeType[],
  edges: Edge[],
  meta: FlowMeta,
): Flow {
  return {
    version: 1,
    id: meta.id,
    name: meta.name,
    nodes: nodes.map(
      (n): FlowNode => ({
        id: n.id,
        type: n.data.blockType,
        position: { x: n.position.x, y: n.position.y },
        params: n.data.params,
        portsOverride: n.data.portsOverride,
        cssOverride: n.data.cssOverride,
      }),
    ),
    edges: edges.flatMap((e) =>
      e.sourceHandle && e.targetHandle
        ? [
            {
              id: e.id,
              source: e.source,
              sourcePort: e.sourceHandle,
              target: e.target,
              targetPort: e.targetHandle,
            },
          ]
        : [],
    ),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Отпечаток исполняемого содержимого флоу: ноды и рёбра без позиций, статуса и имени.
 * Сравнение отпечатков локальной и серверной копии показывает «есть неопубликованные изменения».
 */
export function flowFingerprint(flow: Flow): string {
  return stableStringify({
    nodes: flow.nodes
      .map((n) => ({ id: n.id, type: n.type, params: n.params, portsOverride: n.portsOverride, cssOverride: n.cssOverride }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...flow.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

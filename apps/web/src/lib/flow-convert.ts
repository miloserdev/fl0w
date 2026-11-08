import type { Edge, Node } from "@xyflow/react";
import { getNodePorts, isDataPort, portKind, registry } from "@fl0w/blocks";
import { isLayoutBlock, isResizableBlock, layoutNodeProps, layoutSize } from "./layout";
import type { Flow, FlowNode, Json, PortDef, PortKind, PortsDef } from "@fl0w/schema";

export type BlockNodeData = {
  blockType: string;
  params: Record<string, Json>;
  portsOverride: PortsDef | null;
  cssOverride: string | null;
  /** Pinned node output (pin data): in a manual run the node returns it without executing. */
  pinData?: Record<string, Json> | null;
  /** The node is disabled: it takes no part in the run, the trigger is not registered. */
  disabled?: boolean;
};
/** Canvas node: an ordinary block (`block`) or a decoration block (*/
export type BlockNodeType = Node<BlockNodeData, "block" | "layout-note" | "layout-group" | "terminal">;

export type FlowMeta = Pick<Flow, "id" | "name">;

/** Instance ports: defaults from the class + those added via portsOverride. */
export function getPorts(blockType: string, override: PortsDef | null, params?: Record<string, Json>): PortsDef {
  const cls = registry[blockType];
  return cls ? getNodePorts(cls, override, params) : { inputs: [], outputs: [] };
}

/** Ports split into data (on the sides) and resource ones (at the bottom on the host, at the top on the resource). */
export function splitPorts(ports: PortsDef): {
  dataIn: PortDef[];
  dataOut: PortDef[];
  resourceIn: PortDef[];
  resourceOut: PortDef[];
} {
  return {
    dataIn: ports.inputs.filter(isDataPort),
    dataOut: ports.outputs.filter(isDataPort),
    resourceIn: ports.inputs.filter((p) => !isDataPort(p)),
    resourceOut: ports.outputs.filter((p) => !isDataPort(p)),
  };
}

/** Port kind by node instance; null — no such block or port. */
export function nodePortKind(
  blockType: string,
  override: PortsDef | null,
  side: "inputs" | "outputs",
  portId: string | null | undefined,
  params?: Record<string, Json>,
): PortKind | null {
  const port = getPorts(blockType, override, params)[side].find((p) => p.id === portId);
  return port ? portKind(port) : null;
}

/** CSS class of an edge: resource edges (the source is not a data port) are drawn dashed. */
export function edgeClassFor(kind: PortKind | null): string | undefined {
  return kind && kind !== "data" ? `fl-edge-resource fl-edge-${kind}` : undefined;
}

/** Edge kind by flow nodes (for assigning className). */
export function edgeClass(flow: Pick<Flow, "nodes">, source: string, sourcePort: string): string | undefined {
  const n = flow.nodes.find((x) => x.id === source);
  return n ? edgeClassFor(nodePortKind(n.type, n.portsOverride, "outputs", sourcePort, n.params)) : undefined;
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

/** React Flow node type: decoration blocks have their own renderer, the rest use `block`. */
export function nodeTypeFor(blockType: string): "block" | "layout-note" | "layout-group" | "terminal" {
  if (blockType === "log") return "terminal"; // Log is an ordinary block with ports, but on the canvas it is a black terminal window
  // the name `group` is taken by React Flow's built-in style (border, background) — hence the prefix
  if (!isLayoutBlock(blockType)) return "block";
  return blockType === "group" ? "layout-group" : "layout-note";
}

/** Block params of decoration with the actual node size (resized by the corner — the size lives in node.width/height). */
function paramsOf(n: BlockNodeType): Record<string, Json> {
  if (!isResizableBlock(n.data.blockType)) return n.data.params;
  const size = layoutSize(n.data.blockType, {
    width: n.width ?? n.data.params.width,
    height: n.height ?? n.data.params.height,
  });
  return { ...n.data.params, ...size };
}

/**
 * Whether two sets of nodes/edges are the same for validation and the fingerprint: position, selection and sizes do not count, what counts is id,
 * the `data` object (changes only when editing params/ports/CSS/pinning/disabling) and connections.
 */
export function sameStructure(a: { nodes: BlockNodeType[]; edges: Edge[] }, b: { nodes: BlockNodeType[]; edges: Edge[] }): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    if (a.nodes[i]!.id !== b.nodes[i]!.id || a.nodes[i]!.data !== b.nodes[i]!.data) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    const x = a.edges[i]!;
    const y = b.edges[i]!;
    if (x.id !== y.id || x.source !== y.source || x.target !== y.target || x.sourceHandle !== y.sourceHandle || x.targetHandle !== y.targetHandle) return false;
  }
  return true;
}

export function toReactFlow(flow: Flow): { nodes: BlockNodeType[]; edges: Edge[] } {
  return {
    nodes: flow.nodes.map((n) => ({
      id: n.id,
      type: nodeTypeFor(n.type),
      position: n.position,
      ...layoutNodeProps(n.type, n.params),
      data: {
        blockType: n.type,
        params: n.params,
        portsOverride: n.portsOverride,
        cssOverride: n.cssOverride,
        pinData: n.pinData ?? null,
        ...(n.disabled ? { disabled: true } : {}),
      },
    })),
    edges: flow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourcePort,
      target: e.target,
      targetHandle: e.targetPort,
      className: edgeClass(flow, e.source, e.sourcePort),
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
        params: paramsOf(n),
        portsOverride: n.data.portsOverride,
        cssOverride: n.data.cssOverride,
        ...(n.data.pinData ? { pinData: n.data.pinData } : {}),
        ...(n.data.disabled ? { disabled: true } : {}),
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
 * Fingerprint of the flow's executable content: nodes and edges without positions, status and name.
 * Comparing the fingerprints of the local and server copies shows "there are unpublished changes".
 */
export function flowFingerprint(flow: Flow): string {
  return stableStringify({
    // notes and groups are decoration: editing them does not make a published flow "changed"
    nodes: flow.nodes
      .filter((n) => !registry[n.type]?.layout)
      .map((n) => ({ id: n.id, type: n.type, params: n.params, portsOverride: n.portsOverride, cssOverride: n.cssOverride, disabled: n.disabled === true }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...flow.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/**
 * Data for restarting from a node: node outputs from the last run (by id). The engine takes predecessors' data from them,
 * which are not executed again.
 */
export function collectSeeds(details: Record<string, { output?: Record<string, Json> }>): Record<string, Record<string, Json>> {
  const seeds: Record<string, Record<string, Json>> = {};
  for (const [id, d] of Object.entries(details)) if (d.output) seeds[id] = d.output;
  return seeds;
}

/** Parsing manually entered pinned data: a JSON object `{ port: value }`; otherwise the error text. */
export function parsePin(text: string): { ok: true; value: Record<string, Json> } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "Expected an object like { \"out0\": … }" };
  return { ok: true, value: v as Record<string, Json> };
}

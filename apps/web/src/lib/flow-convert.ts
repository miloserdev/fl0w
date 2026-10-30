import type { Edge, Node } from "@xyflow/react";
import { getNodePorts, isDataPort, portKind, registry } from "@fl0w/blocks";
import { isLayoutBlock, isResizableBlock, layoutNodeProps, layoutSize } from "./layout";
import type { Flow, FlowNode, Json, PortDef, PortKind, PortsDef } from "@fl0w/schema";

export type BlockNodeData = {
  blockType: string;
  params: Record<string, Json>;
  portsOverride: PortsDef | null;
  cssOverride: string | null;
  /** Закреплённый выход ноды (pin data): в ручном запуске нода отдаёт его, не исполняясь. */
  pinData?: Record<string, Json> | null;
};
/** Нода холста: обычный блок (`block`) или блок оформления (*/
export type BlockNodeType = Node<BlockNodeData, "block" | "layout-note" | "layout-group" | "terminal">;

export type FlowMeta = Pick<Flow, "id" | "name">;

/** Порты инстанса: дефолтные из класса + добавленные через portsOverride. */
export function getPorts(blockType: string, override: PortsDef | null, params?: Record<string, Json>): PortsDef {
  const cls = registry[blockType];
  return cls ? getNodePorts(cls, override, params) : { inputs: [], outputs: [] };
}

/** Порты, разделённые на данные (по бокам) и ресурсные (снизу у хозяина, сверху у ресурса). */
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

/** Вид порта по инстансу ноды; null — нет такого блока или порта. */
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

/** Класс CSS ребра: ресурсные рёбра (источник — не порт данных) рисуются пунктиром. */
export function edgeClassFor(kind: PortKind | null): string | undefined {
  return kind && kind !== "data" ? `fl-edge-resource fl-edge-${kind}` : undefined;
}

/** Вид ребра по узлам флоу (для проставления className). */
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

/** Тип ноды React Flow: у блоков оформления собственный отрисовщик, у остальных — `block`. */
export function nodeTypeFor(blockType: string): "block" | "layout-note" | "layout-group" | "terminal" {
  if (blockType === "log") return "terminal"; // Log — обычный блок с портами, но на холсте чёрное окошко-терминал
  // имя `group` занято встроенным стилем React Flow (рамка, фон) — поэтому префикс
  if (!isLayoutBlock(blockType)) return "block";
  return blockType === "group" ? "layout-group" : "layout-note";
}

/** Параметры блока оформления с актуальным размером ноды (тянут за уголок — размер живёт в node.width/height). */
function paramsOf(n: BlockNodeType): Record<string, Json> {
  if (!isResizableBlock(n.data.blockType)) return n.data.params;
  const size = layoutSize(n.data.blockType, {
    width: n.width ?? n.data.params.width,
    height: n.height ?? n.data.params.height,
  });
  return { ...n.data.params, ...size };
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
    // заметки и группы — оформление: их правка не делает опубликованный флоу «изменённым»
    nodes: flow.nodes
      .filter((n) => !registry[n.type]?.layout)
      .map((n) => ({ id: n.id, type: n.type, params: n.params, portsOverride: n.portsOverride, cssOverride: n.cssOverride }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...flow.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/**
 * Данные для перезапуска с ноды: выходы нод из последнего запуска (по id). Движок берёт из них данные предшественников,
 * которые заново не исполняются.
 */
export function collectSeeds(details: Record<string, { output?: Record<string, Json> }>): Record<string, Record<string, Json>> {
  const seeds: Record<string, Record<string, Json>> = {};
  for (const [id, d] of Object.entries(details)) if (d.output) seeds[id] = d.output;
  return seeds;
}

/** Разбор закреплённых данных, введённых вручную: JSON-объект `{ порт: значение }`; иначе текст ошибки. */
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

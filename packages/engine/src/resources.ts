import { getNodePorts, isDataPort, portKind, resolveParamExpressions, resolveParams, validateParams, type MemoryBlock, type ToolBlock } from "@fl0w/blocks";
import type { MemoryHandle, ToolHandle } from "@fl0w/blocks";
import type { Flow, FlowEdge, Json, PortKind } from "@fl0w/schema";
import type { Registry } from "./validate";

/** Edge kind is taken from the source port's kind; unknown nodes and ports count as data (validation reports the error). */
export function edgeKind(flow: Pick<Flow, "nodes">, registry: Registry, e: FlowEdge): PortKind {
  const node = flow.nodes.find((n) => n.id === e.source);
  const cls = node && registry[node.type];
  if (!node || !cls) return "data";
  const port = getNodePorts(cls, node.portsOverride, node.params).outputs.find((p) => p.id === e.sourcePort);
  return portKind(port);
}

/** The flow with data edges only: resource edges do not affect order, input waiting or cycles. */
export function dataView(flow: Flow, registry: Registry): Flow {
  return { ...flow, edges: flow.edges.filter((e) => edgeKind(flow, registry, e) === "data") };
}

/** Resource nodes (sub-nodes) are started not by the data flow but by their host. */
export const isResourceNode = (flow: Pick<Flow, "nodes">, registry: Registry, nodeId: string): boolean => {
  const node = flow.nodes.find((n) => n.id === nodeId);
  return !!node && !!registry[node.type]?.resource;
};

const MAX_LOG_VALUE = 300;
const short = (v: unknown) => {
  const t = typeof v === "string" ? v : (JSON.stringify(v) ?? "undefined");
  return t.length > MAX_LOG_VALUE ? `${t.slice(0, MAX_LOG_VALUE)}…` : t;
};

/**
 * Collects the tools and memory attached to the resource ports of node `hostId`. Sub-node parameters are validated and
 * get `{{ inputs… }}` expressions from the host's inputs. Tool calls are written to the host's log for debugging.
 */
export function buildResources(
  flow: Flow,
  registry: Registry,
  hostId: string,
  hostInputs: Record<string, Json>,
  log: (msg: string) => void,
  signal?: AbortSignal,
): { tools: ToolHandle[]; memory: MemoryHandle[] } {
  const tools: ToolHandle[] = [];
  const memory: MemoryHandle[] = [];
  const names = new Set<string>();

  for (const e of flow.edges) {
    if (e.target !== hostId) continue;
    const node = flow.nodes.find((n) => n.id === e.source);
    const cls = node && registry[node.type];
    if (!node || node.disabled || !cls?.resource) continue; // a disabled tool/memory bank is unavailable to the host

    const params = resolveParamExpressions(cls.params, resolveParams(cls.params, node.params), hostInputs);
    const issues = validateParams(cls.params, params);
    if (issues.length > 0) throw new Error(`Node "${node.id}": ${issues.map((i) => i.message).join("; ")}`);

    if (cls.resource === "tool") {
      const tool = (new cls() as ToolBlock).createTool(params);
      if (names.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" (node "${node.id}")`);
      names.add(tool.name);
      tools.push({
        ...tool,
        async call(args) {
          try {
            const out = await tool.call(args, signal);
            log(`tool ${tool.name}(${short(args)}) → ${short(out)}`);
            return out;
          } catch (err) {
            log(`tool ${tool.name}(${short(args)}) failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }
        },
      });
    } else {
      memory.push((new cls() as MemoryBlock).createMemory(params, signal));
    }
  }
  return { tools, memory };
}

export { isDataPort };

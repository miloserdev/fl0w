import type { Json, PortDef, PortKind, PortsDef } from "@fl0w/schema";
import type { BlockClass } from "./registry";

/** Port kind (data by default). */
export const portKind = (p: PortDef | undefined): PortKind => p?.kind ?? "data";

/** Data port (not a resource port). */
export const isDataPort = (p: PortDef): boolean => portKind(p) === "data";

/**
 * Instance ports: defaults from the class (or parameter-dependent ones via `portsFor`, for example the `err` port of an outgoing call
 * only in await mode) plus those added via portsOverride.
 */
export function getNodePorts(
  cls: Pick<BlockClass, "ports"> & Partial<Pick<BlockClass, "portsFor">>,
  override: PortsDef | null,
  params?: Record<string, Json>,
): PortsDef {
  const base = (params && cls.portsFor?.(params)) || cls.ports;
  return {
    inputs: [...base.inputs, ...(override?.inputs ?? [])],
    outputs: [...base.outputs, ...(override?.outputs ?? [])],
  };
}

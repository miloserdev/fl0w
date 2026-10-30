import type { Json, PortDef, PortKind, PortsDef } from "@fl0w/schema";
import type { BlockClass } from "./registry";

/** Вид порта (по умолчанию — данные). */
export const portKind = (p: PortDef | undefined): PortKind => p?.kind ?? "data";

/** Порт данных (не ресурсный). */
export const isDataPort = (p: PortDef): boolean => portKind(p) === "data";

/**
 * Порты инстанса: дефолтные из класса (или зависящие от параметров — `portsFor`, например порт `err` у phone-outgoing
 * только в режиме await) + добавленные через portsOverride.
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

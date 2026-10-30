import type { PortDef, PortKind, PortsDef } from "@fl0w/schema";
import type { BlockClass } from "./registry";

/** Вид порта (по умолчанию — данные). */
export const portKind = (p: PortDef | undefined): PortKind => p?.kind ?? "data";

/** Порт данных (не ресурсный). */
export const isDataPort = (p: PortDef): boolean => portKind(p) === "data";

/** Порты инстанса: дефолтные из класса + добавленные через portsOverride. */
export function getNodePorts(cls: Pick<BlockClass, "ports">, override: PortsDef | null): PortsDef {
  return {
    inputs: [...cls.ports.inputs, ...(override?.inputs ?? [])],
    outputs: [...cls.ports.outputs, ...(override?.outputs ?? [])],
  };
}

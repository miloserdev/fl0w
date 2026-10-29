import type { PortsDef } from "@fl0w/schema";
import type { BlockClass } from "./registry";

/** Порты инстанса: дефолтные из класса + добавленные через portsOverride. */
export function getNodePorts(cls: Pick<BlockClass, "ports">, override: PortsDef | null): PortsDef {
  return {
    inputs: [...cls.ports.inputs, ...(override?.inputs ?? [])],
    outputs: [...cls.ports.outputs, ...(override?.outputs ?? [])],
  };
}

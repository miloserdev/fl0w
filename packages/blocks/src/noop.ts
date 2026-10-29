import type { Json } from "@fl0w/schema";
import { Block } from "./block";

/** No Operation: пропускает данные без изменений (заглушка, точка соединения). */
export class NoOp extends Block {
  static type = "noop";
  static label = "No Operation";
  static icon = "arrow-right";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params = [];

  async run(inputs: Record<string, Json>) {
    return { out0: inputs["in0"] ?? null };
  }
}

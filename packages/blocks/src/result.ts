import type { Json } from "@fl0w/schema";
import { Block } from "./block";

/** Финальный блок: нет выходов, его вход фиксируется движком как результат запуска. */
export class ResultBlock extends Block {
  static type = "result";
  static label = "Result";
  static icon = "flag";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [] };
  static params = [];
  static defaultCss = "";

  async run(inputs: Record<string, Json>) {
    return { in0: inputs.in0 ?? null };
  }
}

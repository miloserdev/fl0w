import type { Json } from "@fl0w/schema";
import { Block } from "./block";

/** Final block: no outputs; its input is recorded by the engine as the run result. */
export class ResultBlock extends Block {
  static type = "result";
  static label = "Result";
  static icon = "flag";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [] };
  static override serviceOutputs = ["in0"] as const; // for the feed: what Result received
  static params = [];
  static defaultCss = "";

  async run(inputs: Record<string, Json>) {
    return { in0: inputs.in0 ?? null };
  }
}

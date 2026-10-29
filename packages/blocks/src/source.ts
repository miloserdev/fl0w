import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";

export class Source extends Block {
  static type = "source";
  static label = "Source";
  static icon = "database";
  static category = "io";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "json", type: "json", label: "JSON", required: true, default: {} },
  ];
  static defaultCss = "";

  async run(_inputs: Record<string, Json>, params: Record<string, Json>) {
    return { out0: params.json ?? null };
  }
}

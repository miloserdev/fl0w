import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { listAt } from "./list-utils";

/** Limit: keeps the first or last N items of a list. */
export class Limit extends Block {
  static type = "limit";
  static label = "Limit";
  static icon = "list-end";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "path", type: "string", default: "" },
    { name: "count", type: "number", required: true, default: 1, min: 0 },
    {
      name: "keep",
      type: "enum",
      default: "first",
      options: [{ value: "first" }, { value: "last" }],
    },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const list = listAt(inputs["in0"], String(params["path"] ?? ""), "Limit");
    const n = Math.max(0, Math.floor(Number(params["count"] ?? 1)));
    return { out0: params["keep"] === "last" ? list.slice(Math.max(0, list.length - n)) : list.slice(0, n) };
  }
}

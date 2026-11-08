import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { conditionParams, evalCondition } from "./conditions";
import { getPath } from "./json-path";
import { listAt } from "./list-utils";

/** Filter: keeps the items that pass the condition; the others go to the second output. An empty output receives no data. */
export class Filter extends Block {
  static type = "filter";
  static label = "Filter";
  static icon = "filter";
  static category = "data";
  static ports = {
    inputs: [{ id: "in0" }],
    outputs: [
      { id: "out0", label: "kept" },
      { id: "out1", label: "discarded" },
    ],
  };
  static params: ParamSchema[] = [{ name: "path", type: "string", default: "" }, ...conditionParams()];

  async run(inputs: Record<string, Json>, params: Record<string, Json>): Promise<Record<string, Json>> {
    const input = inputs["in0"] ?? null;
    const path = String(params["path"] ?? "");
    const field = String(params["field"] ?? "");
    const op = String(params["operator"] ?? "truthy");
    const passes = (item: Json) => evalCondition(getPath(item, field), op, params["value"]);

    // not an array and the path is empty: a single value goes whole to one of the outputs
    if (path.trim() === "" && !Array.isArray(input)) return passes(input) ? { out0: input } : { out1: input };

    const kept: Json[] = [];
    const discarded: Json[] = [];
    for (const item of listAt(input, path, "Filter")) (passes(item) ? kept : discarded).push(item);
    const out: Record<string, Json> = {};
    if (kept.length > 0) out["out0"] = kept;
    if (discarded.length > 0) out["out1"] = discarded;
    return out;
  }
}

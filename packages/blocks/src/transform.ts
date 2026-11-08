import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { conditionParams, evalCondition } from "./conditions";
import { getPath } from "./json-path";

/** map/filter over an array inside JSON. Everything is declarative: no expressions are executed. */
export class Transform extends Block {
  static type = "transform";
  static label = "Transform";
  static icon = "arrows-shuffle";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    {
      name: "mode",
      type: "enum",
      required: true,
      default: "map",
      options: [{ value: "map" }, { value: "filter" }],
    },
    // path to the array in the input; empty means the input itself
    { name: "path", type: "string", default: "" },
    // map: { "new key": "path in the element" }; null means elements unchanged
    { name: "fields", type: "json", default: null },
    // filter: a condition on an element field
    ...conditionParams(),
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const path = String(params["path"] ?? "");
    const target = getPath(inputs["in0"], path);
    if (!Array.isArray(target)) {
      throw new Error(`Value at "${path || "."}" is not an array`);
    }

    if (params["mode"] === "filter") {
      const field = String(params["field"] ?? "");
      const op = String(params["operator"] ?? "truthy");
      return { out0: target.filter((item) => evalCondition(getPath(item, field), op, params["value"])) };
    }

    const fields = params["fields"];
    if (fields === null || fields === undefined) return { out0: target };
    if (typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error('Parameter "fields" must be an object of { key: "path" }');
    }
    const mapping = Object.entries(fields);
    return {
      out0: target.map((item) => {
        const out: { [key: string]: Json } = {};
        for (const [key, from] of mapping) {
          if (typeof from !== "string") throw new Error(`fields.${key} must be a path string`);
          out[key] = getPath(item, from) ?? null;
        }
        return out;
      }),
    };
  }
}

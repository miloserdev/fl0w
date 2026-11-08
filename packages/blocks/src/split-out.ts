import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { cloneJson, getPath, isPlainObject, setPath } from "./json-path";
import { stringList } from "./list-utils";

/**
 * Split Out: takes an array from an object field and spreads it into items. By default the result is the list of the
 * items themselves; `into` wraps each in { into: item }, `include` adds the remaining fields of the source object.
 */
export class SplitOut extends Block {
  static type = "split_out";
  static label = "Split Out";
  static icon = "unfold-vertical";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "field", type: "string", required: true },
    {
      name: "include",
      type: "enum",
      default: "none",
      options: [{ value: "none" }, { value: "all" }, { value: "selected" }],
    },
    { name: "fieldsToInclude", type: "json", default: [] },
    { name: "into", type: "string", default: "" },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const field = String(params["field"] ?? "");
    const include = String(params["include"] ?? "none");
    const selected = stringList(params["fieldsToInclude"], "fieldsToInclude");
    const into = String(params["into"] ?? "");
    const wrapKey = into || field.split(".").pop()!;

    const input = inputs["in0"] ?? null;
    const sources = Array.isArray(input) ? input : [input];
    const out: Json[] = [];

    for (const source of sources) {
      const list = getPath(source, field);
      if (!Array.isArray(list)) throw new Error(`Split Out: "${field}" is not an array`);
      for (const element of list) {
        if (include === "none" && into === "") {
          out.push(element);
          continue;
        }
        const row: { [key: string]: Json } = {};
        if (isPlainObject(source)) {
          if (include === "all") {
            Object.assign(row, cloneJson(source));
            if (!field.includes(".")) delete row[field];
          } else if (include === "selected") {
            for (const f of selected) {
              const v = getPath(source, f);
              if (v !== undefined) setPath(row, f, cloneJson(v));
            }
          }
        }
        row[wrapKey] = element;
        out.push(row);
      }
    }
    return { out0: out };
  }
}

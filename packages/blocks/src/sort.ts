import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { getPath, isPlainObject } from "./json-path";
import { compareJson, listAt } from "./list-utils";

type Key = { field: string; desc: boolean };

/** Sort: sorts a list by fields (ascending/descending) or shuffles it. The sort is stable. */
export class Sort extends Block {
  static type = "sort";
  static label = "Sort";
  static icon = "arrow-up-down";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "path", type: "string", default: "" },
    {
      name: "mode",
      type: "enum",
      default: "simple",
      options: [{ value: "simple" }, { value: "random" }],
    },
    // ["field", { "field": "a.b", "order": "desc" }]; empty means sort by the value itself
    { name: "fields", type: "json", default: [] },
    {
      name: "order",
      type: "enum",
      default: "asc",
      options: [{ value: "asc" }, { value: "desc" }],
    },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const list = [...listAt(inputs["in0"], String(params["path"] ?? ""), "Sort")];

    if (params["mode"] === "random") {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      return { out0: list };
    }

    const defaultDesc = params["order"] === "desc";
    const raw = params["fields"];
    const keys: Key[] = (Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw]).map((f) => {
      if (typeof f === "string") return { field: f, desc: defaultDesc };
      if (isPlainObject(f) && typeof f["field"] === "string") {
        return { field: f["field"], desc: f["order"] === undefined ? defaultDesc : f["order"] === "desc" };
      }
      throw new Error('Parameter "fields" must be a list of paths or { field, order } objects');
    });
    if (keys.length === 0) keys.push({ field: "", desc: defaultDesc });

    return {
      out0: list.sort((a, b) => {
        for (const k of keys) {
          const c = compareJson(getPath(a, k.field), getPath(b, k.field));
          if (c !== 0) return k.desc ? -c : c;
        }
        return 0;
      }),
    };
  }
}

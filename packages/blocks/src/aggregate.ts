import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { getPath, isPlainObject } from "./json-path";
import { listAt, stringList } from "./list-utils";

type FieldSpec = { field: string; as: string };

function fieldSpecs(raw: Json | undefined): FieldSpec[] {
  const list = raw === undefined || raw === null || raw === "" ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((f) => {
    if (typeof f === "string") return { field: f, as: f };
    if (isPlainObject(f) && typeof f["field"] === "string") {
      return { field: f["field"], as: typeof f["as"] === "string" && f["as"] !== "" ? f["as"] : f["field"] };
    }
    throw new Error('Parameter "fields" must be a list of paths or { field, as } objects');
  });
}

/**
 * Aggregate: collects a list of items into one object. `fields` puts the values of chosen fields into lists
 * ({ field: [values] }); `all` puts all items whole into one field (fields can be selected).
 */
export class Aggregate extends Block {
  static type = "aggregate";
  static label = "Aggregate";
  static icon = "layers";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "path", type: "string", default: "" },
    {
      name: "mode",
      type: "enum",
      required: true,
      default: "fields",
      options: [{ value: "fields" }, { value: "all" }],
    },
    // mode = fields: ["price", { "field": "user.name", "as": "names" }]
    { name: "fields", type: "json", default: [] },
    { name: "mergeLists", type: "boolean", default: false },
    { name: "keepMissing", type: "boolean", default: false },
    // mode = all
    { name: "into", type: "string", default: "data" },
    {
      name: "include",
      type: "enum",
      default: "all",
      options: [{ value: "all" }, { value: "only" }, { value: "except" }],
    },
    { name: "fieldsList", type: "json", default: [] },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const list = listAt(inputs["in0"], String(params["path"] ?? ""), "Aggregate");

    if (params["mode"] === "all") {
      const names = stringList(params["fieldsList"], "fieldsList");
      const include = String(params["include"] ?? "all");
      const items = list.map((item) => {
        if (include === "all" || !isPlainObject(item)) return item;
        const pick = Object.entries(item).filter(([k]) => (include === "only" ? names.includes(k) : !names.includes(k)));
        return Object.fromEntries(pick);
      });
      return { out0: { [String(params["into"] || "data")]: items } };
    }

    const specs = fieldSpecs(params["fields"]);
    if (specs.length === 0) throw new Error('Aggregate: list the fields to collect in "fields"');
    const out: { [key: string]: Json } = {};
    for (const { field, as } of specs) {
      const values: Json[] = [];
      for (const item of list) {
        const v = getPath(item, field);
        const missing = v === undefined || v === null;
        if (missing && params["keepMissing"] !== true) continue;
        if (params["mergeLists"] === true && Array.isArray(v)) values.push(...v);
        else values.push(missing ? null : v);
      }
      out[as] = values;
    }
    return { out0: out };
  }
}

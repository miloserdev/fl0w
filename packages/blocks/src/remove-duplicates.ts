import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { getPath } from "./json-path";
import { listAt, stableKey, stringList } from "./list-utils";

/** Remove Duplicates: removes repeats by the whole value or by chosen fields; the first occurrence stays. */
export class RemoveDuplicates extends Block {
  static type = "remove_duplicates";
  static label = "Remove Duplicates";
  static icon = "copy-x";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "path", type: "string", default: "" },
    {
      name: "compare",
      type: "enum",
      default: "all",
      options: [{ value: "all" }, { value: "fields" }],
    },
    // for compare = fields: ["id", "user.email"]
    { name: "fields", type: "json", default: [] },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const list = listAt(inputs["in0"], String(params["path"] ?? ""), "Remove Duplicates");
    const fields = params["compare"] === "fields" ? stringList(params["fields"], "fields") : [];
    if (params["compare"] === "fields" && fields.length === 0) {
      throw new Error('Remove Duplicates: list the fields to compare in "fields"');
    }
    const seen = new Set<string>();
    const out: Json[] = [];
    for (const item of list) {
      const key = fields.length > 0 ? stableKey(fields.map((f) => getPath(item, f) ?? null)) : stableKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return { out0: out };
  }
}

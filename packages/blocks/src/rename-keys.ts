import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { cloneJson, isPlainObject } from "./json-path";

/** Renames a key by path inside a value, keeping field order. */
function renameAt(value: Json, segs: string[], newName: string): Json {
  if (!isPlainObject(value)) return value;
  const [head, ...rest] = segs;
  if (head === undefined || !Object.hasOwn(value, head)) return value;
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== head) out[k] = v;
    else if (rest.length === 0) out[newName] = v;
    else out[k] = renameAt(v, rest, newName);
  }
  return out;
}

/** Rename Keys: renames fields by a { "old": "new" } map; a dotted path changes a nested field. */
export class RenameKeys extends Block {
  static type = "rename_keys";
  static label = "Rename Keys";
  static icon = "replace";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [{ name: "keys", type: "json", required: true, default: {} }];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const keys = params["keys"];
    if (!isPlainObject(keys)) throw new Error('Parameter "keys" must be an object like { "old": "new" }');
    const entries = Object.entries(keys).map(([from, to]) => {
      if (typeof to !== "string" || to === "" || to.includes(".")) {
        throw new Error(`New name for "${from}" must be a non-empty string without dots`);
      }
      return { segs: from.split("."), to };
    });

    const rename = (item: Json): Json => entries.reduce((acc, e) => renameAt(acc, e.segs, e.to), cloneJson(item));
    const input = inputs["in0"] ?? null;
    return { out0: Array.isArray(input) ? input.map(rename) : rename(input) };
  }
}

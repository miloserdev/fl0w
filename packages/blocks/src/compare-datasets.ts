import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { cloneJson, deletePath, getPath, isPlainObject } from "./json-path";
import { listAt, stableKey, stringList } from "./list-utils";

/** Нестрогое сравнение (fuzzy): 3 и "3" равны; объекты и массивы — рекурсивно. */
function looseEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => looseEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && looseEqual(a[k], b[k]));
  }
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}

/**
 * Compare Datasets: сравнивает два списка по ключевому полю. Выходы: только в A, одинаковые, различающиеся,
 * только в B. Пустой выход данных не получает. Различия — версия A, версия B или обе (`keys`/`same`/`different`).
 */
export class CompareDatasets extends Block {
  static type = "compare_datasets";
  static label = "Compare Datasets";
  static icon = "git-compare";
  static category = "flow";
  static ports = {
    inputs: [
      { id: "in0", label: "A" },
      { id: "in1", label: "B" },
    ],
    outputs: [
      { id: "out0", label: "A only" },
      { id: "out1", label: "same" },
      { id: "out2", label: "different" },
      { id: "out3", label: "B only" },
    ],
  };
  static params: ParamSchema[] = [
    { name: "fieldA", type: "string", required: true },
    // пусто — то же поле, что у A
    { name: "fieldB", type: "string", default: "" },
    { name: "skip", type: "json", default: [] },
    { name: "fuzzy", type: "boolean", default: false },
    {
      name: "resolve",
      type: "enum",
      default: "both",
      options: [{ value: "a" }, { value: "b" }, { value: "both" }],
    },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const fieldA = String(params["fieldA"] ?? "");
    const fieldB = String(params["fieldB"] || fieldA);
    const fuzzy = params["fuzzy"] === true;
    const skip = stringList(params["skip"], "skip");
    const resolve = String(params["resolve"] ?? "both");

    const listA = inputs["in0"] === undefined ? [] : listAt(inputs["in0"], "", "Compare Datasets");
    const listB = inputs["in1"] === undefined ? [] : listAt(inputs["in1"], "", "Compare Datasets");

    const keyOf = (item: Json, field: string, side: string, i: number): string => {
      const v = getPath(item, field);
      if (v === undefined) throw new Error(`Compare Datasets: field "${field}" not found in item ${i} of input ${side}`);
      return fuzzy ? String(v) : stableKey(v);
    };
    const stripped = (item: Json): Json => {
      if (skip.length === 0 || !isPlainObject(item)) return item;
      const copy = cloneJson(item);
      for (const s of skip) deletePath(copy, s);
      return copy;
    };
    const sameItems = (a: Json, b: Json) =>
      fuzzy ? looseEqual(stripped(a), stripped(b)) : stableKey(stripped(a)) === stableKey(stripped(b));

    const byKey = new Map<string, { item: Json; used: boolean }>();
    listB.forEach((item, i) => {
      const k = keyOf(item, fieldB, "B", i);
      if (!byKey.has(k)) byKey.set(k, { item, used: false });
    });

    const aOnly: Json[] = [];
    const same: Json[] = [];
    const different: Json[] = [];
    listA.forEach((a, i) => {
      const k = keyOf(a, fieldA, "A", i);
      const match = byKey.get(k);
      if (!match) return void aOnly.push(a);
      match.used = true;
      if (sameItems(a, match.item)) return void same.push(a);
      if (resolve === "a") return void different.push(a);
      if (resolve === "b") return void different.push(match.item);
      const diff: { [key: string]: Json } = {};
      const eq: { [key: string]: Json } = {};
      const objA = isPlainObject(a) ? stripped(a) as { [key: string]: Json } : {};
      const objB = isPlainObject(match.item) ? stripped(match.item) as { [key: string]: Json } : {};
      for (const key of new Set([...Object.keys(objA), ...Object.keys(objB)])) {
        const va = objA[key];
        const vb = objB[key];
        const equal = fuzzy ? looseEqual(va, vb) : stableKey(va) === stableKey(vb);
        if (equal) eq[key] = va ?? null;
        else diff[key] = { inputA: va ?? null, inputB: vb ?? null };
      }
      different.push({ keys: { [fieldA]: getPath(a, fieldA) ?? null }, same: eq, different: diff });
    });
    const bOnly = [...byKey.values()].filter((e) => !e.used).map((e) => e.item);

    const out: Record<string, Json> = {};
    if (aOnly.length > 0) out["out0"] = aOnly;
    if (same.length > 0) out["out1"] = same;
    if (different.length > 0) out["out2"] = different;
    if (bOnly.length > 0) out["out3"] = bOnly;
    return out;
  }
}

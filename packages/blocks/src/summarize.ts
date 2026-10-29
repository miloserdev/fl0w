import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { getPath, isPlainObject, setPath } from "./json-path";
import { listAt, stableKey, stringList } from "./list-utils";

const OPS = ["count", "countUnique", "sum", "average", "min", "max", "append", "concatenate"] as const;
type Op = (typeof OPS)[number];
type Agg = { field: string; op: Op; as: string; separator: string };

function parseAggregations(raw: Json | undefined): Agg[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Summarize: describe what to compute in "aggregations", e.g. [{ "field": "price", "op": "sum" }]');
  }
  return raw.map((a, i) => {
    if (!isPlainObject(a)) throw new Error(`aggregations[${i}] must be an object`);
    const op = a["op"];
    if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
      throw new Error(`aggregations[${i}].op must be one of: ${OPS.join(", ")}`);
    }
    const field = typeof a["field"] === "string" ? a["field"] : "";
    return {
      field,
      op: op as Op,
      as: typeof a["as"] === "string" && a["as"] !== "" ? a["as"] : field ? `${op}_${field}` : op,
      separator: typeof a["separator"] === "string" ? a["separator"] : ", ",
    };
  });
}

const present = (v: Json | undefined): v is Json => v !== undefined && v !== null && v !== "";
const num = (v: Json): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function compute(items: Json[], a: Agg): Json {
  const values = a.field ? items.map((item) => getPath(item, a.field)) : items;
  const got = values.filter(present);
  switch (a.op) {
    case "count":
      return got.length;
    case "countUnique":
      return new Set(got.map(stableKey)).size;
    case "append":
      return got;
    case "concatenate":
      return got.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(a.separator);
    default: {
      const nums = got.map(num).filter((n): n is number => n !== null);
      if (a.op === "sum") return nums.reduce((s, n) => s + n, 0);
      if (nums.length === 0) return null;
      if (a.op === "average") return nums.reduce((s, n) => s + n, 0) / nums.length;
      return a.op === "min" ? Math.min(...nums) : Math.max(...nums);
    }
  }
}

/**
 * Summarize: сводка по списку, как в сводных таблицах — count, countUnique, sum, average, min, max,
 * append, concatenate; с группировкой по полям (`groupBy`) получается строка на каждую группу.
 */
export class Summarize extends Block {
  static type = "summarize";
  static label = "Summarize";
  static icon = "sigma";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "path", type: "string", default: "" },
    // [{ "field": "amount", "op": "sum", "as": "total" }]; op: count, countUnique, sum, average, min, max, append, concatenate
    {
      name: "aggregations",
      type: "json",
      required: true,
      default: [{ field: "", op: "count", as: "count" }],
    },
    { name: "groupBy", type: "json", default: [] },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const list = listAt(inputs["in0"], String(params["path"] ?? ""), "Summarize");
    const aggs = parseAggregations(params["aggregations"]);
    const groupBy = stringList(params["groupBy"], "groupBy");

    const summarize = (items: Json[], keys: { [key: string]: Json }) => {
      const row: { [key: string]: Json } = { ...keys };
      for (const a of aggs) setPath(row, a.as, compute(items, a));
      return row;
    };

    if (groupBy.length === 0) return { out0: summarize(list, {}) };

    const groups = new Map<string, { keys: { [key: string]: Json }; items: Json[] }>();
    for (const item of list) {
      const values = groupBy.map((g) => getPath(item, g));
      if (values.some((v) => v === undefined)) continue; // нет поля группировки — элемент пропускаем
      const id = stableKey(values.map((v) => v ?? null));
      let g = groups.get(id);
      if (!g) {
        const keys: { [key: string]: Json } = {};
        groupBy.forEach((name, i) => setPath(keys, name, values[i] ?? null));
        groups.set(id, (g = { keys, items: [] }));
      }
      g.items.push(item);
    }
    return { out0: [...groups.values()].map((g) => summarize(g.items, g.keys)) };
  }
}

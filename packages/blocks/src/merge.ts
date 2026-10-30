import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";

const isPlainObject = (v: Json | undefined): v is { [key: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Объединитель: собирает данные со всех ПОДКЛЮЧЁННЫХ входов в один JSON.
 * В один вход идёт одно ребро (SPEC §4), поэтому несколько веток сводятся здесь.
 * Параметр `wait` — когда запускаться: `all` (по умолчанию, как у любой ноды) — когда данные пришли по ВСЕМ подключённым входам
 * (если ветка не пошла, Merge не запускается); `any` — когда пришёл хотя бы один вход: объединяются те, что пришли, остальные
 * (не пошедшие ветки, например после Branch) пропускаются.
 */
export class Merge extends Block {
  static type = "merge";
  static label = "Merge";
  static icon = "git-merge";
  static category = "flow";
  static ports = {
    inputs: [{ id: "in0" }, { id: "in1" }, { id: "in2" }, { id: "in3" }],
    outputs: [{ id: "out0" }],
  };
  static waitMode(params: Record<string, Json>): "all" | "any" {
    return params["wait"] === "any" ? "any" : "all";
  }
  static params: ParamSchema[] = [
    {
      name: "wait",
      type: "enum",
      default: "all",
      options: [{ value: "all" }, { value: "any" }],
    },
    {
      name: "mode",
      type: "enum",
      required: true,
      default: "array",
      options: [{ value: "array" }, { value: "object" }, { value: "assign" }, { value: "concat" }],
    },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    // порядок входов — по номеру порта, а не по порядку рёбер
    const ids = Object.keys(inputs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const values = ids.map((id) => inputs[id]!);

    switch (String(params["mode"] ?? "array")) {
      case "array":
        return { out0: values };
      case "object":
        return { out0: Object.fromEntries(ids.map((id) => [id, inputs[id]!])) };
      case "assign": {
        const out: { [key: string]: Json } = {};
        for (const id of ids) {
          const v = inputs[id]!;
          if (!isPlainObject(v)) throw new Error(`Input "${id}" is not an object`);
          Object.assign(out, v); // позднее перекрывает раннее
        }
        return { out0: out };
      }
      case "concat": {
        const out: Json[] = [];
        for (const id of ids) {
          const v = inputs[id]!;
          if (!Array.isArray(v)) throw new Error(`Input "${id}" is not an array`);
          out.push(...v);
        }
        return { out0: out };
      }
      default:
        throw new Error(`Unknown mode "${String(params["mode"])}"`);
    }
  }
}

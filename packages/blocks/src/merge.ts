import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";

const isPlainObject = (v: Json | undefined): v is { [key: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Merger: collects data from all CONNECTED inputs into one JSON.
 * One input takes one edge, so several branches are joined here.
 * The `wait` parameter says when to run: `all` (default, like any node) when data has arrived on ALL connected inputs
 * (if a branch did not fire, Merge does not run); `any` when at least one input has arrived: those that arrived are merged, the others
 * (branches that did not fire, for example after Branch) are skipped.
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
    // input order follows the port number, not the edge order
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
          Object.assign(out, v); // a later one overrides an earlier one
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

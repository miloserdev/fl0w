import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { CONDITION_OPERATORS, evalCondition } from "./conditions";
import { getPath, isPlainObject } from "./json-path";

const MAX_RULES = 4;

/**
 * Switch: routes data to one of the outputs by rules. Rule i -> output `out{i}`; if no rule
 * fires, `fallback`. By default the first matching rule wins; in `all` mode all of them do.
 */
export class Switch extends Block {
  static type = "switch";
  static label = "Switch";
  static icon = "split";
  static category = "flow";
  static ports = {
    inputs: [{ id: "in0" }],
    outputs: [
      { id: "out0", label: "0" },
      { id: "out1", label: "1" },
      { id: "out2", label: "2" },
      { id: "out3", label: "3" },
      { id: "fallback", label: "fallback" },
    ],
  };
  static params: ParamSchema[] = [
    // a common field for the rules; a rule can set its own: { "field": "a", "operator": "eq", "value": 1 }
    { name: "field", type: "string", default: "" },
    {
      name: "rules",
      type: "json",
      required: true,
      default: [{ operator: "eq", value: "" }],
    },
    {
      name: "mode",
      type: "enum",
      default: "first",
      options: [{ value: "first" }, { value: "all" }],
    },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>): Promise<Record<string, Json>> {
    const rules = params["rules"];
    if (!Array.isArray(rules) || rules.length === 0) throw new Error('Switch: "rules" must be a non-empty list');
    if (rules.length > MAX_RULES) throw new Error(`Switch supports at most ${MAX_RULES} rules`);

    const data = inputs["in0"] ?? null;
    const shared = String(params["field"] ?? "");
    const all = params["mode"] === "all";
    const out: Record<string, Json> = {};

    for (const [i, rule] of rules.entries()) {
      if (!isPlainObject(rule) || typeof rule["operator"] !== "string") {
        throw new Error(`rules[${i}] must be { operator, value } (operators: ${CONDITION_OPERATORS.join(", ")})`);
      }
      const field = typeof rule["field"] === "string" ? rule["field"] : shared;
      if (evalCondition(getPath(data, field), rule["operator"], rule["value"])) {
        out[`out${i}`] = data;
        if (!all) return out;
      }
    }
    if (Object.keys(out).length === 0) out["fallback"] = data;
    return out;
  }
}

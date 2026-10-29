import type { Json, ParamSchema } from "@fl0w/schema";
import { deepEqual } from "./json-path";

export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "exists",
  "truthy",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Общие параметры условия для Branch и режима filter у Transform. */
export function conditionParams(): ParamSchema[] {
  return [
    { name: "field", type: "string", default: "" },
    {
      name: "operator",
      type: "enum",
      default: "truthy",
      options: CONDITION_OPERATORS.map((value) => ({ value })),
    },
    { name: "value", type: "json", default: null },
  ];
}

function compare(a: Json | undefined, b: Json | undefined): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null; // разные типы — не сравниваем
}

/** Декларативная проверка условия: пользовательский код тут не исполняется (SPEC §12). */
export function evalCondition(
  actual: Json | undefined,
  operator: string,
  operand: Json | undefined,
): boolean {
  switch (operator as ConditionOperator) {
    case "eq":
      return deepEqual(actual, operand);
    case "neq":
      return !deepEqual(actual, operand);
    case "gt":
      return (compare(actual, operand) ?? Number.NaN) > 0;
    case "gte":
      return (compare(actual, operand) ?? Number.NaN) >= 0;
    case "lt":
      return (compare(actual, operand) ?? Number.NaN) < 0;
    case "lte":
      return (compare(actual, operand) ?? Number.NaN) <= 0;
    case "contains":
      if (typeof actual === "string") return typeof operand === "string" && actual.includes(operand);
      if (Array.isArray(actual)) return actual.some((v) => deepEqual(v, operand));
      return false;
    case "exists":
      return actual !== undefined && actual !== null;
    case "truthy":
      return Boolean(actual);
    default:
      throw new Error(`Unknown operator "${operator}"`);
  }
}

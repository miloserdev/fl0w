import type { Json, ParamSchema } from "@fl0w/schema";
import { hasExpression, resolveInputsExpressions } from "./json-path";

export type ParamIssue = {
  param: string;
  code: "required" | "type" | "enum" | "range";
  message: string;
};

function isEmpty(v: Json | undefined): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Значения нода + default'ы из схемы для отсутствующих ключей. */
export function resolveParams(
  schema: readonly ParamSchema[],
  values: Record<string, Json>,
): Record<string, Json> {
  const out = { ...values };
  for (const p of schema) {
    if (out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  }
  return out;
}

/** Виден ли параметр при текущих значениях (`showWhen`); `resolved` — значения вместе с default'ами. */
export function isParamVisible(p: ParamSchema, resolved: Record<string, Json>): boolean {
  if (!p.showWhen) return true;
  const v = resolved[p.showWhen.param];
  return typeof v === "string" && p.showWhen.in.includes(v);
}

/**
 * Значения параметров с подставленными выражениями `{{ inputs… }}` (кроме параметров с `expressions: false`).
 * Вызывается движком перед запуском блока.
 */
export function resolveParamExpressions(
  schema: readonly ParamSchema[],
  values: Record<string, Json>,
  inputs: Record<string, Json>,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = schema.find((p) => p.name === k)?.expressions === false ? v : resolveInputsExpressions(v, inputs);
  }
  return out;
}

export type ValidateOptions = {
  /**
   * Значение-выражение (`{{ … }}`) в числовом, булевом, enum и multienum параметре не проверяется по типу и диапазону:
   * его значение появится только при запуске, а после подстановки движок проверяет параметры ещё раз.
   */
  allowExpressions?: boolean;
};

/** Проверка значений по `class.params`: required, типы, enum-опции. Неизвестные ключи игнорируются. */
export function validateParams(
  schema: readonly ParamSchema[],
  values: Record<string, Json>,
  options: ValidateOptions = {},
): ParamIssue[] {
  const resolved = resolveParams(schema, values);
  const issues: ParamIssue[] = [];

  for (const p of schema) {
    if (!isParamVisible(p, resolved)) continue; // скрытый параметр сейчас не используется
    const v = resolved[p.name];
    if (isEmpty(v)) {
      if (p.required) {
        issues.push({ param: p.name, code: "required", message: `Parameter "${p.name}" is required` });
      }
      continue;
    }
    if (options.allowExpressions && p.type !== "string" && p.type !== "json" && hasExpression(v)) continue;
    switch (p.type) {
      case "string":
        if (typeof v !== "string") issues.push(typeIssue(p.name, "a string"));
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          issues.push(typeIssue(p.name, "a number"));
        } else if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) {
          const bounds = [p.min !== undefined && `>= ${p.min}`, p.max !== undefined && `<= ${p.max}`]
            .filter(Boolean)
            .join(" and ");
          issues.push({ param: p.name, code: "range", message: `Parameter "${p.name}" must be ${bounds}` });
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") issues.push(typeIssue(p.name, "a boolean"));
        break;
      case "enum":
        if (typeof v !== "string" || !p.options.some((o) => o.value === v)) {
          issues.push({
            param: p.name,
            code: "enum",
            message: `Parameter "${p.name}" must be one of: ${p.options.map((o) => o.value).join(", ")}`,
          });
        }
        break;
      case "multienum": {
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          issues.push(typeIssue(p.name, "a list of strings"));
          break;
        }
        const unknown = (v as string[]).filter((x) => !p.options.some((o) => o.value === x));
        if (unknown.length > 0) {
          issues.push({
            param: p.name,
            code: "enum",
            message: `Parameter "${p.name}" contains unknown values: ${unknown.join(", ")}`,
          });
        }
        break;
      }
      case "json":
        break;
    }
  }
  return issues;
}

function typeIssue(param: string, expected: string): ParamIssue {
  return { param, code: "type", message: `Parameter "${param}" must be ${expected}` };
}

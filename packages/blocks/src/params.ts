import type { Json, ParamSchema } from "@fl0w/schema";

export type ParamIssue = {
  param: string;
  code: "required" | "type" | "enum" | "range";
  message: string;
};

function isEmpty(v: Json | undefined): boolean {
  return v === undefined || v === null || v === "";
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

/** Проверка значений по `class.params`: required, типы, enum-опции. Неизвестные ключи игнорируются. */
export function validateParams(
  schema: readonly ParamSchema[],
  values: Record<string, Json>,
): ParamIssue[] {
  const resolved = resolveParams(schema, values);
  const issues: ParamIssue[] = [];

  for (const p of schema) {
    const v = resolved[p.name];
    if (isEmpty(v)) {
      if (p.required) {
        issues.push({ param: p.name, code: "required", message: `Parameter "${p.name}" is required` });
      }
      continue;
    }
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
      case "json":
        break;
    }
  }
  return issues;
}

function typeIssue(param: string, expected: string): ParamIssue {
  return { param, code: "type", message: `Parameter "${param}" must be ${expected}` };
}

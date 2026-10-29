import type { Json } from "@fl0w/schema";
import { interpolate, isPlainObject, setPath } from "./json-path";

/**
 * Значение, над которым работает блок: параметр `raw` с подстановкой `{{ путь }}` из входа.
 * Пустой параметр означает «взять сам вход». Шаблон, которому нечего подставить (поля нет или оно null),
 * — ошибка: молча обрабатывать `null` вместо данных значило бы скрыть опечатку в пути.
 */
export function valueOf(input: Json | undefined, raw: Json | undefined): Json {
  if (raw === undefined || raw === null || raw === "") return input ?? null;
  const v = typeof raw === "string" ? interpolate(raw, input) : raw;
  if (v === null) throw new Error(`Nothing to work with: ${JSON.stringify(raw)} resolved to no value`);
  return v;
}

/** Строковое представление значения (объекты — JSON). */
export function textOf(v: Json): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Результат блока: `{ [field]: result }`; при `includeInput` поле дописывается к входному объекту.
 * Так в n8n устроены «Output Field Name» и «Include Input Fields».
 */
export function withOutputField(
  input: Json | undefined,
  params: Record<string, Json>,
  result: Json,
  fallbackField: string,
): Json {
  const field = String(params["field"] || fallbackField);
  const base: { [key: string]: Json } = params["includeInput"] === true && isPlainObject(input) ? { ...input } : {};
  setPath(base, field, result);
  return base;
}

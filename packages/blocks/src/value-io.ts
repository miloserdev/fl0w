import type { Json } from "@fl0w/schema";
import { interpolate, isPlainObject, setPath } from "./json-path";

/**
 * The value a block works on: the `raw` parameter with `{{ path }}` substitution from the input.
 * An empty parameter means "take the input itself". A template with nothing to substitute (the field is missing or null)
 * is an error: silently processing `null` instead of data would hide a typo in the path.
 */
export function valueOf(input: Json | undefined, raw: Json | undefined): Json {
  if (raw === undefined || raw === null || raw === "") return input ?? null;
  const v = typeof raw === "string" ? interpolate(raw, input) : raw;
  if (v === null) throw new Error(`Nothing to work with: ${JSON.stringify(raw)} resolved to no value`);
  return v;
}

/** String representation of a value (objects as JSON). */
export function textOf(v: Json): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Block result: `{ [field]: result }`; with `includeInput` the field is appended to the input object.
 * This is how "Output Field Name" and "Include Input Fields" work in n8n.
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

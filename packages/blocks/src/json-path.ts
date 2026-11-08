import type { Json } from "@fl0w/schema";

/** Gets a value by a dotted path (`a.b.0.c`). An empty path or `.` is the value itself. */
export function getPath(value: Json | undefined, path: string): Json | undefined {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === ".") return value;
  let cur: Json | undefined = value;
  for (const key of trimmed.split(".")) {
    if (Array.isArray(cur)) {
      cur = /^\d+$/.test(key) ? cur[Number(key)] : undefined;
    } else if (cur !== null && typeof cur === "object") {
      cur = Object.hasOwn(cur, key) ? cur[key] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export const isPlainObject = (v: Json | undefined): v is { [key: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** An array as is, a missing value is an empty list, any other value is a one-element list. */
export function toList(v: Json | undefined): Json[] {
  if (Array.isArray(v)) return v;
  return v === undefined ? [] : [v];
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function segments(path: string): string[] {
  const keys = path.trim().split(".");
  if (keys.some((k) => k === "" || FORBIDDEN_KEYS.has(k))) throw new Error(`Invalid path "${path}"`);
  return keys;
}

/** Writes a value by a dotted path, creating intermediate objects. Mutates `target`. */
export function setPath(target: { [key: string]: Json }, path: string, value: Json): void {
  const keys = segments(path);
  let cur = target;
  for (const key of keys.slice(0, -1)) {
    const next = Object.hasOwn(cur, key) ? cur[key] : undefined;
    if (isPlainObject(next)) {
      cur = next;
    } else {
      const created: { [key: string]: Json } = {};
      cur[key] = created;
      cur = created;
    }
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Removes a value by a dotted path; a missing path is not an error. Mutates `target`. */
export function deletePath(target: { [key: string]: Json }, path: string): void {
  const keys = segments(path);
  let cur: Json | undefined = target;
  for (const key of keys.slice(0, -1)) {
    cur = isPlainObject(cur) && Object.hasOwn(cur, key) ? cur[key] : undefined;
  }
  const last = keys[keys.length - 1]!;
  if (isPlainObject(cur) && Object.hasOwn(cur, last)) delete cur[last];
}

/** Deep copy of a JSON value. */
export function cloneJson<T extends Json>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
// a "whole" template is the entire string without outer whitespace: otherwise a trailing newline would be silently lost
const WHOLE_TEMPLATE = /^\{\{\s*([^{}]*?)\s*\}\}$/;

/**
 * Substitution of `{{ path.to.field }}` from `data`: a replacement for n8n expressions, without executing code.
 * A string consisting of one template keeps the value's type; inside text the value is converted to a string
 * (objects as JSON, a missing value as an empty string). `{{ . }}` is the value itself.
 */
export function interpolate(template: string, data: Json | undefined): Json {
  const whole = WHOLE_TEMPLATE.exec(template);
  if (whole) return getPath(data, whole[1]!) ?? null;
  return template.replace(TEMPLATE, (_m, path: string) => {
    const v = getPath(data, path);
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// Node-level expressions: `{{ inputs.in0.field }}` is data from the input ports (like $json in n8n). The engine substitutes it
// before running the block in ANY parameter; relative templates `{{ field }}` are left to the blocks (they work per list item).
const INPUTS_TEMPLATE = /\{\{\s*(inputs(?:\.[^{}\s]+)?)\s*\}\}/g;
export const WHOLE_INPUTS_TEMPLATE = /^\{\{\s*(inputs(?:\.[^{}\s]+)?)\s*\}\}$/;

/** Whether the value contains a `{{ ... }}` expression (parameter validation defers typing until the run). */
export function hasExpression(v: Json | undefined): boolean {
  return typeof v === "string" && /\{\{[^{}]*\}\}/.test(v);
}

/**
 * Substitutes `{{ inputs.portx.path }}` into all strings of the value. A string of one expression keeps the type
 * (number, object...), inside text the value is converted to a string; no value gives `null` / an empty string.
 * Other `{{ ... }}` are left untouched.
 */
export function resolveInputsExpressions(value: Json, inputs: Record<string, Json>): Json {
  const root = { inputs } as unknown as Json;
  const walk = (v: Json): Json => {
    if (typeof v === "string") {
      const whole = WHOLE_INPUTS_TEMPLATE.exec(v);
      if (whole) return getPath(root, whole[1]!) ?? null;
      return v.replace(INPUTS_TEMPLATE, (_m, path: string) => {
        const x = getPath(root, path);
        if (x === undefined || x === null) return "";
        return typeof x === "string" ? x : JSON.stringify(x);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/** Recursively substitutes templates into all strings of the value. */
export function resolveTemplates(value: Json, data: Json | undefined): Json {
  if (typeof value === "string") return interpolate(value, data);
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, data));
  if (isPlainObject(value)) {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplates(v, data);
    return out;
  }
  return value;
}

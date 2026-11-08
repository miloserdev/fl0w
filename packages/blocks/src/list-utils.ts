import type { Json } from "@fl0w/schema";
import { getPath, isPlainObject, toList } from "./json-path";

/** Deterministic key of a value: objects with the same content give the same key regardless of field order. */
export function stableKey(v: Json | undefined): string {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/**
 * List to process: the value at `path` (empty means the input itself). An array is taken as is, a single value becomes
 * a one-element list (like a single item in n8n). A path that does not exist is an error.
 */
export function listAt(input: Json | undefined, path: string, block: string): Json[] {
  const target = getPath(input, path);
  if (target === undefined && path.trim() !== "" && path.trim() !== ".") {
    throw new Error(`${block}: nothing found at "${path}"`);
  }
  return toList(target ?? null);
}

/** Array of strings from a parameter; the string "a, b, c" is also accepted. */
export function stringList(v: Json | undefined, name: string): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new Error(`Parameter "${name}" must be a list of strings`);
}

const TYPE_RANK = (v: Json | undefined): number =>
  v === undefined || v === null ? 5 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : Array.isArray(v) ? 3 : 4;

/** Total order for JSON: numbers < strings < booleans < arrays < objects < null/missing. */
export function compareJson(a: Json | undefined, b: Json | undefined): number {
  const ra = TYPE_RANK(a);
  const rb = TYPE_RANK(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (ra === 3 || ra === 4) {
    const ka = stableKey(a);
    const kb = stableKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }
  return 0;
}

/** `Promise.all` with a limit on concurrently running tasks (results are in the order of the original list). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return out;
}

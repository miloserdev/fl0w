import type { Json } from "@fl0w/schema";
import { getPath, isPlainObject, toList } from "./json-path";

/** Детерминированный ключ значения: объекты с одинаковым содержимым дают один ключ независимо от порядка полей. */
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
 * Список для обработки: значение по `path` (пусто — сам вход). Массив — как есть, одиночное значение —
 * список из одного элемента (как единственный item в n8n). Путь, которого нет, — ошибка.
 */
export function listAt(input: Json | undefined, path: string, block: string): Json[] {
  const target = getPath(input, path);
  if (target === undefined && path.trim() !== "" && path.trim() !== ".") {
    throw new Error(`${block}: nothing found at "${path}"`);
  }
  return toList(target ?? null);
}

/** Массив строк из параметра; допускается и строка «a, b, c». */
export function stringList(v: Json | undefined, name: string): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new Error(`Parameter "${name}" must be a list of strings`);
}

const TYPE_RANK = (v: Json | undefined): number =>
  v === undefined || v === null ? 5 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : Array.isArray(v) ? 3 : 4;

/** Полный порядок для JSON: числа < строки < булевы < массивы < объекты < null/отсутствует. */
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

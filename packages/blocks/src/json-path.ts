import type { Json } from "@fl0w/schema";

/** Достаёт значение по точечному пути (`a.b.0.c`). Пустой путь или `.` — само значение. */
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

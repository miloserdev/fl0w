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

export const isPlainObject = (v: Json | undefined): v is { [key: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Массив — как есть, отсутствие значения — пустой список, любое другое значение — список из одного элемента. */
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

/** Записывает значение по точечному пути, создавая промежуточные объекты. Мутирует `target`. */
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

/** Удаляет значение по точечному пути; отсутствующий путь — не ошибка. Мутирует `target`. */
export function deletePath(target: { [key: string]: Json }, path: string): void {
  const keys = segments(path);
  let cur: Json | undefined = target;
  for (const key of keys.slice(0, -1)) {
    cur = isPlainObject(cur) && Object.hasOwn(cur, key) ? cur[key] : undefined;
  }
  const last = keys[keys.length - 1]!;
  if (isPlainObject(cur) && Object.hasOwn(cur, last)) delete cur[last];
}

/** Глубокая копия JSON-значения. */
export function cloneJson<T extends Json>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
// «целый» шаблон — вся строка без внешних пробелов: иначе завершающий перевод строки молча терялся бы
const WHOLE_TEMPLATE = /^\{\{\s*([^{}]*?)\s*\}\}$/;

/**
 * Подстановка `{{ путь.к.полю }}` из `data` — замена выражениям n8n, без исполнения кода.
 * Строка из одного шаблона сохраняет тип значения; в составе текста значение приводится к строке
 * (объекты — JSON, отсутствующее — пустая строка). `{{ . }}` — само значение.
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

/** Рекурсивно подставляет шаблоны во все строки значения. */
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { Counter } from "./counter";
import { Log } from "./log";
import { MEMORY_DIR_ENV } from "./memory";
import { validateParams } from "./params";
import { registry } from "./registry";

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[MEMORY_DIR_ENV];
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-counter-"));
  process.env[MEMORY_DIR_ENV] = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env[MEMORY_DIR_ENV];
  else process.env[MEMORY_DIR_ENV] = saved;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ signal: new AbortController().signal, log: (m: string) => void logs.push(m) });
let logs: string[] = [];
beforeEach(() => {
  logs = [];
});
const count = async (params: Record<string, Json>, input: Json = { a: 1 }) => {
  const out = (await new Counter().run({ in0: input }, params, ctx())) as { out0: Record<string, Json> };
  return out.out0;
};
const val = async (params: Record<string, Json>) => ((await count(params))["counter"] as { value: number }).value;

describe("Counter", () => {
  it("считает запуски и переживает их: 1, 2, 3; результат — { name, value, previous } в поле counter", async () => {
    expect(await count({ name: "c" })).toEqual({ counter: { name: "c", value: 1, previous: 0 } });
    expect(await val({ name: "c" })).toBe(2);
    expect(await count({ name: "c" })).toMatchObject({ counter: { value: 3, previous: 2 } });
  });

  it("decrement, шаг, начальное значение, reset и get (get не создаёт и не меняет счётчик)", async () => {
    expect(await val({ name: "s", start: 10, step: 5 })).toBe(15);
    expect(await val({ name: "s", operation: "decrement", step: 3 })).toBe(12);
    expect(await val({ name: "s", operation: "get" })).toBe(12);
    expect(await val({ name: "s", operation: "reset", start: 10 })).toBe(10);
    expect(await val({ name: "never", operation: "get", start: 7 })).toBe(7);
    expect(await val({ name: "never", operation: "get", start: 99 })).toBe(99); // не создан — start виден заново
    expect(await val({ name: "never" })).toBe(1);
  });

  it("счётчики независимы по имени; включение входа и свое поле результата", async () => {
    await val({ name: "a" });
    await val({ name: "a" });
    expect(await val({ name: "b" })).toBe(1);
    const out = await count({ name: "a", field: "n", includeInput: true }, { user: "ann" });
    expect(out).toEqual({ user: "ann", n: { name: "a", value: 3, previous: 2 } });
  });

  it("параллельные запуски не теряют приращений (атомарно)", async () => {
    await Promise.all(Array.from({ length: 30 }, () => count({ name: "par" })));
    expect(await val({ name: "par", operation: "get" })).toBe(30);
  });

  it("ошибки: пустое/запрещённое имя, неизвестная операция, плохой step, нечисловое значение в хранилище", async () => {
    await expect(count({ name: "" })).rejects.toThrow(/Counter name/);
    await expect(count({ name: "x".repeat(257) })).rejects.toThrow(/Counter name/);
    await expect(count({ name: "__proto__" })).rejects.toThrow(/not allowed/);
    await expect(count({ name: "z", operation: "explode" })).rejects.toThrow(/Unknown operation/);
    await expect(count({ name: "z", step: -1 })).rejects.toThrow(/step/);
    await expect(count({ name: "z", start: Number.NaN })).rejects.toThrow(/start/);
    // имя вроде constructor — обычный ключ, прототип не «подмешивается» как значение
    expect(await val({ name: "constructor" })).toBe(1);
    expect(await val({ name: "toString" })).toBe(1);
  });

  it("без каталога памяти — понятная ошибка", async () => {
    delete process.env[MEMORY_DIR_ENV];
    await expect(count({ name: "c" })).rejects.toThrow(/not configured/);
  });
});

describe("Log", () => {
  const run = (input: Json, params: Record<string, Json> = {}) => new Log().run({ in0: input }, params, ctx());

  it("по умолчанию пишет весь вход как JSON и пропускает данные дальше без изменений", async () => {
    const out = await run({ a: [1, 2] });
    expect(logs).toEqual(['{"a":[1,2]}']);
    expect(out).toEqual({ out0: { a: [1, 2] } });
  });

  it("сообщение с шаблонами из входа; строка — как есть; многострочное — отдельные строки лога", async () => {
    await run({ user: { name: "Ann" }, n: 3 }, { message: "hello {{ user.name }} #{{ n }}" });
    expect(logs).toEqual(["hello Ann #3"]);
    logs = [];
    await run({ x: 1 }, { message: "line1\nline2" });
    expect(logs).toEqual(["line1", "line2"]);
    logs = [];
    await run("plain text");
    expect(logs).toEqual(["plain text"]);
  });

  it("уровень добавляет префикс (по нему терминал красит строки); неизвестный уровень — ошибка", async () => {
    await run(1, { message: "careful", level: "warn" });
    await run(1, { message: "bad", level: "error" });
    expect(logs).toEqual(["[warn] careful", "[error] bad"]);
    await expect(run(1, { level: "debug" })).rejects.toThrow(/Unknown level/);
  });

  it("шаблон без значения не роняет ноду: пустая подстановка", async () => {
    await run({ a: 1 }, { message: "x={{ nope }}" });
    expect(logs).toEqual(["x="]);
  });
});

describe("реестр: Counter и Log", () => {
  it("метаданные, порты, размеры и параметры по умолчанию валидны", () => {
    expect(registry["counter"]!.ports).toEqual({ inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] });
    expect(registry["log"]!.resizable).toBe(true);
    expect(registry["counter"]!.resizable).toBe(false);
    expect(registry["note"]!.resizable).toBe(true);
    for (const t of ["counter", "log"]) expect(validateParams(registry[t]!.params, {}), t).toEqual([]);
  });
});

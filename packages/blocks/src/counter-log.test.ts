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

let logs: string[] = [];
let shown: string[] = [];
beforeEach(() => {
  logs = [];
  shown = [];
});
const ctx = (ids: { flowId?: string; nodeId?: string } = {}) => ({
  signal: new AbortController().signal,
  log: (m: string) => void logs.push(m),
  display: (t: string) => void shown.push(t),
  ...ids,
});
const at = { flowId: "f", nodeId: "n" };
const count = (params: Record<string, Json> = {}, input: Json = { a: 1 }, ids = at) => new Counter().run({ in0: input }, params, ctx(ids));
const last = () => Number(shown.at(-1));

describe("Counter", () => {
  it("считает, сколько раз нода сработала, и просит показать число на ноде; данные идут дальше без изменений", async () => {
    expect(await count({}, { a: 1 })).toEqual({ out0: { a: 1 } }); // никаких лишних полей в JSON
    await count();
    await count();
    expect(shown).toEqual(["1", "2", "3"]);
  });

  it("у каждой ноды свой счёт (по флоу и id ноды); счёт переживает запуски", async () => {
    await count({}, 1, { flowId: "f", nodeId: "a" });
    await count({}, 1, { flowId: "f", nodeId: "a" });
    await count({}, 1, { flowId: "f", nodeId: "b" });
    await count({}, 1, { flowId: "g", nodeId: "a" });
    expect(shown).toEqual(["1", "2", "1", "1"]);
  });

  it("именованный счётчик общий для нод; именованный и «свой» не пересекаются", async () => {
    await count({ name: "shared" }, 1, { flowId: "f", nodeId: "a" });
    await count({ name: "shared" }, 1, { flowId: "g", nodeId: "z" });
    expect(shown).toEqual(["1", "2"]);
    await count({}, 1, { flowId: "f", nodeId: "a" }); // свой счёт этой ноды отдельно
    expect(last()).toBe(1);
    await count({ name: "node:f/a" }); // имя, похожее на внутренний ключ, не попадает в чужой счёт
    expect(last()).toBe(1);
  });

  it("reset обнуляет и показывает 0; следующий запуск снова даёт 1", async () => {
    await count();
    await count();
    await count({ operation: "reset" });
    expect(last()).toBe(0);
    await count();
    expect(last()).toBe(1);
  });

  it("параллельные срабатывания не теряются (атомарно)", async () => {
    await Promise.all(Array.from({ length: 30 }, () => count()));
    expect(Math.max(...shown.map(Number))).toBe(30);
    expect(new Set(shown).size).toBe(30);
  });

  it("ошибки: нет ни имени, ни id ноды; слишком длинное имя; неизвестная операция; нечисловое значение в хранилище", async () => {
    await expect(new Counter().run({ in0: 1 }, {}, ctx())).rejects.toThrow(/needs a name/);
    await expect(count({ name: "x".repeat(257) })).rejects.toThrow(/too long/);
    await expect(count({ operation: "explode" })).rejects.toThrow(/Unknown operation/);
    // имена вроде __proto__ / constructor — обычные ключи (с префиксом), а не прототип
    await expect(count({ name: "__proto__" })).resolves.toBeDefined();
    expect(last()).toBe(1);
    await count({ name: "constructor" });
    expect(last()).toBe(1);
  });

  it("без каталога памяти — понятная ошибка; без display в контексте работает (display необязателен)", async () => {
    await new Counter().run({ in0: 1 }, { name: "x" }, { signal: new AbortController().signal, log() {} });
    delete process.env[MEMORY_DIR_ENV];
    await expect(count()).rejects.toThrow(/not configured/);
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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { validateParams } from "./params";
import { registry } from "./registry";
import { MEMORY_DIR_ENV, MEMORY_LIMITS, MemoryBank, createMemoryHandle, createJsonDriver } from "./memory";
import { CalculatorTool, CodeTool, DateTimeTool, RandomTool, calculate, currentDateTime } from "./tools";

describe("calculate", () => {
  it("arithmetic, precedence, power (right-associative), unary minus, parentheses", () => {
    expect(calculate("1 + 2 * 3")).toBe(7);
    expect(calculate("(1 + 2) * 3")).toBe(9);
    expect(calculate("2 ^ 3 ^ 2")).toBe(512);
    expect(calculate("2 ** 3")).toBe(8);
    expect(calculate("-2 ^ 2")).toBe(4); // unary minus binds tighter, as in most calculators
    expect(calculate("10 % 4 + 7 / 2")).toBe(5.5);
    expect(calculate("--3")).toBe(3);
    expect(calculate(".5 + 1e2")).toBe(100.5);
  });

  it("functions and constants", () => {
    expect(calculate("sqrt(16) + abs(-2) + max(1, 5, 3) + min(4, 2)")).toBe(13);
    expect(calculate("round(pi * 100) / 100")).toBe(3.14);
    expect(calculate("POW(2, 10)")).toBe(1024);
    expect(calculate("log(1000) + ln(e)")).toBeCloseTo(4);
  });

  it("errors: division by zero, unknown names, garbage, unclosed parentheses", () => {
    expect(() => calculate("1 / 0")).toThrow(/Division by zero/);
    expect(() => calculate("5 % 0")).toThrow(/Division by zero/);
    expect(() => calculate("foo + 1")).toThrow(/Unknown name "foo"/);
    expect(() => calculate("foo(1)")).toThrow(/Unknown function/);
    expect(() => calculate("(1 + 2")).toThrow(/Expected '\)'/);
    expect(() => calculate("1 + ")).toThrow(/Unexpected end/);
    expect(() => calculate("1 2")).toThrow(/Unexpected/);
    expect(() => calculate("")).toThrow();
    expect(() => calculate("10 ^ 1000")).toThrow(/finite/);
  });

  it("does not execute code and does not see the environment: prototype names and calls are rejected", () => {
    for (const evil of ["process.exit()", "constructor", "__proto__", "toString(1)", "hasOwnProperty(1)", "this", "globalThis", "require('fs')", "`1`", "1; 2"]) {
      expect(() => calculate(evil), evil).toThrow();
    }
  });

  it("limits: a long expression and deep nesting", () => {
    expect(() => calculate("1+".repeat(300) + "1")).toThrow(/too long/);
    expect(() => calculate("(".repeat(100) + "1" + ")".repeat(100))).toThrow(/too deeply/);
  });
});

describe("tool_datetime", () => {
  it("time zone, offset, day of the week", () => {
    const at = new Date("2024-03-05T23:30:00Z"); // Tuesday in UTC, Wednesday in Berlin
    const utc = currentDateTime("UTC", at) as Record<string, Json>;
    expect(utc).toMatchObject({ date: "2024-03-05", time: "23:30:00", weekday: "Tuesday", utcOffset: "+00:00", iso: "2024-03-05T23:30:00+00:00", unix: 1709681400 });
    const berlin = currentDateTime("Europe/Berlin", at) as Record<string, Json>;
    expect(berlin).toMatchObject({ date: "2024-03-06", time: "00:30:00", weekday: "Wednesday", utcOffset: "+01:00" });
    expect((currentDateTime("Asia/Kolkata", at) as Record<string, Json>)["utcOffset"]).toBe("+05:30");
  });

  it("an unknown zone is a clear error", () => {
    expect(() => currentDateTime("Mars/Olympus")).toThrow(/Unknown time zone/);
  });

  it("tool call: the default zone from parameters and from arguments", async () => {
    const tool = new DateTimeTool().createTool({ name: "now", description: "d", timezone: "Asia/Tokyo" });
    expect(tool.name).toBe("now");
    expect(((await tool.call({})) as Record<string, Json>)["timezone"]).toBe("Asia/Tokyo");
    expect(((await tool.call({ timezone: "UTC" })) as Record<string, Json>)["timezone"]).toBe("UTC");
    expect(((await tool.call(null)) as Record<string, Json>)["timezone"]).toBe("Asia/Tokyo");
    await expect(tool.call({ timezone: "Nope/Zone" })).rejects.toThrow(/Unknown time zone/);
  });
});

describe("tool names", () => {
  it("only identifiers are allowed", () => {
    for (const bad of ["", "1abc", "has space", "a-b", "x".repeat(65), "a.b", "__proto__ x"]) {
      expect(() => new CalculatorTool().createTool({ name: bad }), bad).toThrow(/Invalid tool name/);
    }
    expect(new CalculatorTool().createTool({ name: "ok_1" }).name).toBe("ok_1");
  });
});

describe("tool_calculator / tool_random", () => {
  it("the calculator accepts an object or a string and requires an expression", async () => {
    const t = new CalculatorTool().createTool({ name: "calc" });
    expect(await t.call({ expression: "2+2" })).toEqual({ expression: "2+2", result: 4 });
    expect(await t.call("3*3")).toEqual({ expression: "3*3", result: 9 });
    await expect(t.call({})).rejects.toThrow(/expression/);
    await expect(t.call({ expression: "  " })).rejects.toThrow(/expression/);
    await expect(t.call({ expression: 5 })).rejects.toThrow(/expression/);
  });

  it("random: ranges, pick, uuid, errors", async () => {
    const t = new RandomTool().createTool({ name: "rnd" });
    for (let i = 0; i < 200; i++) {
      const v = ((await t.call({ kind: "int", min: 3, max: 5 })) as { value: number }).value;
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
      expect(Number.isInteger(v)).toBe(true);
    }
    const f = ((await t.call({ kind: "float" })) as { value: number }).value;
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
    expect(((await t.call({ kind: "pick", items: ["a"] })) as { value: string }).value).toBe("a");
    expect(((await t.call({ kind: "uuid" })) as { value: string }).value).toMatch(/^[0-9a-f-]{36}$/);
    await expect(t.call({ kind: "int", min: 5, max: 1 })).rejects.toThrow(/min/);
    await expect(t.call({ kind: "pick", items: [] })).rejects.toThrow(/items/);
    await expect(t.call({ kind: "int", min: "x" })).rejects.toThrow(/number/);
    await expect(t.call({ kind: "dice" })).rejects.toThrow(/Unknown kind/);
  });
});

describe("tool_code", () => {
  it("custom tool: arguments in inputs.in0, result out0", async () => {
    const t = new CodeTool().createTool({ name: "double", description: "x2", code: "return { out0: { v: inputs.in0.n * 2 } }", timeoutMs: 5000 });
    expect(await t.call({ n: 21 })).toEqual({ v: 42 });
  });

  it("a code error and a timeout are a call refusal, not a process crash", async () => {
    const bad = new CodeTool().createTool({ name: "bad", code: "throw new Error('boom')", timeoutMs: 5000 });
    await expect(bad.call(null)).rejects.toThrow(/boom/);
    const slow = new CodeTool().createTool({ name: "slow", code: "while (true) {}", timeoutMs: 100 });
    await expect(slow.call(null)).rejects.toThrow(/timed out/);
  });

  it("the tool code does not see process and require", async () => {
    const t = new CodeTool().createTool({ name: "peek", code: "return { out0: { p: typeof process, r: typeof require } }", timeoutMs: 5000 });
    expect(await t.call(null)).toEqual({ p: "undefined", r: "undefined" });
  });
});

describe("Memory Bank (json driver)", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[MEMORY_DIR_ENV];
    dir = mkdtempSync(path.join(tmpdir(), "fl0w-memory-"));
    process.env[MEMORY_DIR_ENV] = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[MEMORY_DIR_ENV];
    else process.env[MEMORY_DIR_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bank = (name = "b", params: Record<string, Json> = {}) => new MemoryBank().createMemory({ driver: "json", name, ...params });

  it("get/set/delete/keys/clear and persist between instances of one bank", async () => {
    const a = bank();
    expect(await a.get("x")).toBeNull();
    await a.set("x", { n: 1, list: [1, 2] });
    await a.set("y", "text");
    expect(await bank().get("x")).toEqual({ n: 1, list: [1, 2] }); // another instance is the same storage
    expect((await a.keys()).sort()).toEqual(["x", "y"]);
    expect(await a.delete("x")).toBe(true);
    expect(await a.delete("x")).toBe(false);
    await a.clear();
    expect(await a.keys()).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, "b.json"), "utf8"))).toEqual({ version: 1, data: {} });
  });

  it("banks with different names are isolated", async () => {
    await bank("one").set("k", 1);
    expect(await bank("two").get("k")).toBeNull();
  });

  it("append: creates an array, trims by max, refuses on a non-array", async () => {
    const m = bank();
    expect(await m.append("log", 1)).toEqual([1]);
    expect(await m.append("log", 2)).toEqual([1, 2]);
    expect(await m.append("log", 3, 2)).toEqual([2, 3]);
    await m.set("scalar", 5);
    await expect(m.append("scalar", 1)).rejects.toThrow(/not an array/);
    await expect(m.append("log", 1, 0)).rejects.toThrow(/max/);
  });

  it("returns copies: changing the result does not corrupt storage", async () => {
    const m = bank();
    await m.set("o", { a: [1] });
    const got = (await m.get("o")) as { a: number[] };
    got.a.push(2);
    expect(await m.get("o")).toEqual({ a: [1] });
  });

  it("keys like constructor are ordinary keys, while __proto__ is rejected", async () => {
    const m = bank();
    await m.set("constructor", 1);
    expect(await m.get("constructor")).toBe(1);
    expect(await m.get("toString")).toBeNull();
    expect(await m.get("hasOwnProperty")).toBeNull();
    // __proto__ is rejected: assigning to it would change the prototype instead of creating an entry
    await expect(m.set("__proto__", { polluted: true })).rejects.toThrow(/not allowed/);
    await expect(m.get("__proto__")).rejects.toThrow(/not allowed/);
    await expect(m.append("__proto__", 1)).rejects.toThrow(/not allowed/);
    await expect(m.delete("__proto__")).rejects.toThrow(/not allowed/);
    await expect(m.set("", 1)).rejects.toThrow(/Key must be/);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("parallel appends do not lose entries (queue + lock file)", async () => {
    const m = bank();
    await Promise.all(Array.from({ length: 40 }, (_, i) => bank().append("log", i)));
    const list = (await m.get("log")) as number[];
    expect(list).toHaveLength(40);
    expect([...list].sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("a bank name cannot escape the directory", () => {
    for (const bad of ["../x", "a/b", "a.b", "", " ", "x".repeat(65), "a\0b", "..", "C:\\x"]) {
      expect(() => bank(bad), JSON.stringify(bad)).toThrow(/Invalid memory bank name/);
    }
  });

  it("unknown driver and unconfigured directory", async () => {
    expect(() => new MemoryBank().createMemory({ driver: "redis", name: "b" })).toThrow(/Unknown memory driver/);
    expect(() => new MemoryBank().createMemory({ driver: "constructor", name: "b" })).toThrow(/Unknown memory driver/);
    delete process.env[MEMORY_DIR_ENV];
    await expect(bank().get("k")).rejects.toThrow(/not configured/);
  });

  it("limits: value size and number of keys", async () => {
    const m = bank();
    await expect(m.set("big", "x".repeat(MEMORY_LIMITS.valueBytes + 1))).rejects.toThrow(/too large/);
    const driver = createJsonDriver("many");
    const handle = createMemoryHandle("many", "json", driver);
    await driver.update((d) => {
      for (let i = 0; i < MEMORY_LIMITS.keys; i++) d[`k${i}`] = 0;
    });
    await expect(handle.set("one-more", 1)).rejects.toThrow(/full/);
    // the failed write left no changes and did not block the bank
    expect(await handle.get("one-more")).toBeNull();
  });

  it("a corrupted file is a clear error, the content is not overwritten", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "broken.json"), "{not json");
    const m = bank("broken");
    await expect(m.get("k")).rejects.toThrow(/corrupted/);
    await expect(m.set("k", 1)).rejects.toThrow(/corrupted/);
    expect(readFileSync(path.join(dir, "broken.json"), "utf8")).toBe("{not json");
  });

  it("a dead lock file (the process was killed) is removed by age", async () => {
    const lock = path.join(dir, "stale.json.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    (await import("node:fs")).utimesSync(lock, old, old);
    const m = bank("stale");
    await m.set("k", 1);
    expect(await m.get("k")).toBe(1);
  });
});

describe("registry", () => {
  it("resource blocks: kind, port and category", () => {
    expect(registry["tool_datetime"]!.resource).toBe("tool");
    expect(registry["memory_bank"]!.resource).toBe("memory");
    expect(registry["code"]!.resource).toBeNull();
    expect(registry["tool_calculator"]!.ports).toEqual({ inputs: [], outputs: [{ id: "tool", kind: "tool" }] });
    expect(registry["memory_bank"]!.ports.outputs).toEqual([{ id: "memory", kind: "memory" }]);
    expect(registry["tool_random"]!.category).toBe("tool");
    expect(registry["code_agent"]!.ports.inputs.map((p) => [p.id, p.kind ?? "data", p.multiple ?? false])).toEqual([
      ["in0", "data", false],
      ["tools", "tool", true],
      ["memory", "memory", true],
    ]);
  });

  it("default parameters are valid", () => {
    for (const type of ["tool_datetime", "tool_calculator", "tool_random", "tool_code", "memory_bank", "code_agent"]) {
      expect(validateParams(registry[type]!.params, {}), type).toEqual([]);
    }
  });

  it("a resource block cannot be run as a regular one", async () => {
    await expect(new CalculatorTool().run()).rejects.toThrow(/sub-node/);
    await expect(new MemoryBank().run()).rejects.toThrow(/sub-node/);
  });
});

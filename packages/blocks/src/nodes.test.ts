import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { Aggregate } from "./aggregate";
import type { Block, RunContext } from "./block";
import { CompareDatasets } from "./compare-datasets";
import { CodeBlock } from "./code";
import { Crypto } from "./crypto";
import { DateTime } from "./datetime";
import { Filter } from "./filter";
import { cloneJson, deletePath, hasExpression, interpolate, resolveInputsExpressions, resolveTemplates, setPath, toList } from "./json-path";
import { Jwt } from "./jwt";
import { Limit } from "./limit";
import { compareJson, stableKey } from "./list-utils";
import { ManualTrigger } from "./manual";
import { NoOp } from "./noop";
import { resolveParamExpressions, resolveParams, validateParams } from "./params";
import { RemoveDuplicates } from "./remove-duplicates";
import { RenameKeys } from "./rename-keys";
import { RespondToWebhook } from "./respond-to-webhook";
import { SetFields } from "./set";
import { Shell } from "./shell";
import { Sort } from "./sort";
import { SplitOut } from "./split-out";
import { StopAndError } from "./stop-and-error";
import { Summarize } from "./summarize";
import { Switch } from "./switch";
import { Wait } from "./wait";
import { Webhook, normalizeWebhookPath } from "./webhook";

type Cls = { new (): Block; params: import("@fl0w/schema").ParamSchema[] };
const noSignal = () => new AbortController().signal;
/** Runs a block the same way as the engine: parameters are filled in with defaults. */
const run = (
  cls: Cls,
  input: Json | undefined,
  params: Record<string, Json> = {},
  ctx: Partial<RunContext> = {},
  extraInputs: Record<string, Json> = {},
) =>
  new cls().run(
    { ...(input === undefined ? {} : { in0: input }), ...extraInputs },
    resolveParams(cls.params, params),
    { log() {}, signal: noSignal(), ...ctx },
  );
const out0 = async (...a: Parameters<typeof run>) => (await run(...a))["out0"];

describe("path and template utilities", () => {
  it("setPath creates nested objects and overwrites non-objects", () => {
    const o: { [k: string]: Json } = { a: 1 };
    setPath(o, "a.b.c", 2);
    setPath(o, "x", 3);
    expect(o).toEqual({ a: { b: { c: 2 } }, x: 3 });
  });
  it("setPath/deletePath do not allow poisoning the prototype", () => {
    for (const p of ["__proto__.x", "a.constructor.b", "prototype", "a..b", ""]) {
      expect(() => setPath({}, p, 1), p).toThrow(/Invalid path/);
    }
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
  it("deletePath", () => {
    const o: { [k: string]: Json } = { a: { b: 1, c: 2 }, d: 3 };
    deletePath(o, "a.b");
    deletePath(o, "no.such.path");
    expect(o).toEqual({ a: { c: 2 }, d: 3 });
  });
  it("interpolate: a single template keeps the type, inside text it is a string", () => {
    const data = { n: 5, user: { name: "Ann" }, list: [1, 2], none: null };
    expect(interpolate("{{ n }}", data)).toBe(5);
    expect(interpolate("{{user}}", data)).toEqual({ name: "Ann" });
    expect(interpolate("Hi {{ user.name }}, n={{n}}", data)).toBe("Hi Ann, n=5");
    expect(interpolate("{{ list }}", data)).toEqual([1, 2]);
    expect(interpolate("x={{ list }}", data)).toBe("x=[1,2]");
    expect(interpolate("a{{ missing }}b{{ none }}c", data)).toBe("abc");
    expect(interpolate("{{ missing }}", data)).toBeNull();
    expect(interpolate("{{ . }}", data)).toBe(data);
    expect(interpolate("no templates", data)).toBe("no templates");
    // spaces and newlines AROUND a template are part of the text: the type is not kept, the spaces are not lost
    expect(interpolate("{{ n }}\n", data)).toBe("5\n");
    expect(interpolate(" {{ n }} ", data)).toBe(" 5 ");
    expect(interpolate("{{ user.name }}\n", data)).toBe("Ann\n");
  });
  it("resolveTemplates walks nested values", () => {
    expect(resolveTemplates({ a: ["{{ x }}", 1], b: { c: "v={{x}}" } }, { x: 7 })).toEqual({ a: [7, 1], b: { c: "v=7" } });
  });
  it("toList / stableKey / compareJson", () => {
    expect(toList([1])).toEqual([1]);
    expect(toList(5)).toEqual([5]);
    expect(toList(undefined)).toEqual([]);
    expect(stableKey({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableKey({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(stableKey(1)).not.toBe(stableKey("1"));
    expect([3, "b", null, 1, "a", true].sort(compareJson)).toEqual([1, 3, "a", "b", true, null]);
  });
});

describe("No Operation / Manual Trigger", () => {
  it("noop passes data as is", async () => {
    expect(await out0(NoOp, { a: [1] })).toEqual({ a: [1] });
    expect(await out0(NoOp, undefined)).toBeNull();
  });
  it("manual returns a timestamp and has no inputs", async () => {
    expect(ManualTrigger.ports.inputs).toEqual([]);
    expect(ManualTrigger.isTrigger).toBe(true);
    expect(ManualTrigger.autoTrigger).toBe(false);
    expect((await out0(ManualTrigger, undefined) as { triggeredAt: string }).triggeredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("Edit Fields (Set)", () => {
  it("sets, overwrites, nests and substitutes templates with types", async () => {
    const out = await out0(SetFields, { name: "Ann", n: 2 }, {
      fields: { greeting: "Hello {{ name }}", double: "{{ n }}", "meta.source": "api", name: "Bob" },
    });
    expect(out).toEqual({ name: "Bob", n: 2, greeting: "Hello Ann", double: 2, meta: { source: "api" } });
  });
  it("templates read the source data, not partially changed data", async () => {
    expect(await out0(SetFields, { a: 1 }, { fields: { a: 2, b: "{{ a }}" } })).toEqual({ a: 2, b: 1 });
  });
  it("keepOnlySet and remove", async () => {
    expect(await out0(SetFields, { a: 1, b: 2 }, { fields: { c: "{{ a }}" }, keepOnlySet: true })).toEqual({ c: 1 });
    expect(await out0(SetFields, { a: 1, b: { x: 1, y: 2 } }, { remove: ["a", "b.x", "nope"] })).toEqual({ b: { y: 2 } });
    expect(await out0(SetFields, { a: 1, b: 2 }, { remove: "a, b" })).toEqual({});
  });
  it("an array is processed element by element, the input is not mutated", async () => {
    const input = [{ n: 1 }, { n: 2 }];
    expect(await out0(SetFields, input, { fields: { sq: "{{ n }}", tag: "x" } })).toEqual([
      { n: 1, sq: 1, tag: "x" },
      { n: 2, sq: 2, tag: "x" },
    ]);
    expect(input).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("errors: not an object, broken fields, a dangerous path", async () => {
    await expect(run(SetFields, 5, { fields: { a: 1 } })).rejects.toThrow(/object/);
    await expect(run(SetFields, {}, { fields: [1] })).rejects.toThrow(/object of/);
    await expect(run(SetFields, {}, { fields: { "__proto__.x": 1 } })).rejects.toThrow(/Invalid path/);
    expect(await out0(SetFields, 5, { fields: { a: 1 }, keepOnlySet: true })).toEqual({ a: 1 }); // no base needed
  });
});

describe("Filter", () => {
  const items = [{ n: 1 }, { n: 5 }, { n: 9 }];
  it("kept / discarded", async () => {
    expect(await run(Filter, items, { field: "n", operator: "gt", value: 4 })).toEqual({ out0: [{ n: 5 }, { n: 9 }], out1: [{ n: 1 }] });
  });
  it("an empty output receives no data", async () => {
    expect(await run(Filter, items, { field: "n", operator: "gt", value: 100 })).toEqual({ out1: items });
    expect(await run(Filter, items, { field: "n", operator: "exists" })).toEqual({ out0: items });
    expect(await run(Filter, [], { field: "n" })).toEqual({});
  });
  it("a single value goes whole", async () => {
    expect(await run(Filter, { n: 5 }, { field: "n", operator: "gt", value: 1 })).toEqual({ out0: { n: 5 } });
    expect(await run(Filter, { n: 0 }, { field: "n", operator: "gt", value: 1 })).toEqual({ out1: { n: 0 } });
  });
  it("path and a missing path", async () => {
    expect(await run(Filter, { rows: items }, { path: "rows", field: "n", operator: "lt", value: 2 })).toEqual({
      out0: [{ n: 1 }],
      out1: [{ n: 5 }, { n: 9 }],
    });
    await expect(run(Filter, {}, { path: "rows" })).rejects.toThrow('nothing found at "rows"');
  });
});

describe("Sort", () => {
  it("numbers ascending and descending (numeric, not string comparison)", async () => {
    expect(await out0(Sort, [10, 9, 100, 1])).toEqual([1, 9, 10, 100]);
    expect(await out0(Sort, [10, 9, 100, 1], { order: "desc" })).toEqual([100, 10, 9, 1]);
  });
  it("by a field, by several fields and a different order", async () => {
    const people = [
      { name: "b", age: 30 },
      { name: "a", age: 30 },
      { name: "c", age: 20 },
    ];
    expect(await out0(Sort, people, { fields: ["age"] })).toEqual([people[2], people[0], people[1]]); // stability
    expect(await out0(Sort, people, { fields: [{ field: "age", order: "desc" }, "name"] })).toEqual([people[1], people[0], people[2]]);
  });
  it("mixed types and missing values go to the end", async () => {
    expect(await out0(Sort, [{ v: null }, { v: "b" }, {}, { v: 2 }, { v: "a" }], { fields: ["v"] })).toEqual([
      { v: 2 }, { v: "a" }, { v: "b" }, { v: null }, {},
    ]);
  });
  it("random is a permutation of the same elements; the input does not change", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = (await out0(Sort, input, { mode: "random" })) as number[];
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("broken fields", async () => {
    await expect(run(Sort, [1], { fields: [5] })).rejects.toThrow(/fields/);
  });
});

describe("Limit", () => {
  it("first / last / zero / more than the length", async () => {
    expect(await out0(Limit, [1, 2, 3, 4], { count: 2 })).toEqual([1, 2]);
    expect(await out0(Limit, [1, 2, 3, 4], { count: 2, keep: "last" })).toEqual([3, 4]);
    expect(await out0(Limit, [1, 2], { count: 0 })).toEqual([]);
    expect(await out0(Limit, [1, 2], { count: 0, keep: "last" })).toEqual([]);
    expect(await out0(Limit, [1, 2], { count: 10 })).toEqual([1, 2]);
    expect(await out0(Limit, { rows: [1, 2, 3] }, { path: "rows", count: 1 })).toEqual([1]);
  });
});

describe("Remove Duplicates", () => {
  it("by the whole value: key order does not matter, the first stays", async () => {
    expect(await out0(RemoveDuplicates, [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1 }, 1, "1", 1])).toEqual([{ a: 1, b: 2 }, { a: 1 }, 1, "1"]);
  });
  it("by fields", async () => {
    const rows = [{ id: 1, v: "a" }, { id: 2, v: "a" }, { id: 1, v: "b" }];
    expect(await out0(RemoveDuplicates, rows, { compare: "fields", fields: ["id"] })).toEqual([rows[0], rows[1]]);
    expect(await out0(RemoveDuplicates, rows, { compare: "fields", fields: "v" })).toEqual([rows[0], rows[2]]);
  });
  it("compare=fields without fields is an error", async () => {
    await expect(run(RemoveDuplicates, [1], { compare: "fields" })).rejects.toThrow(/fields/);
  });
});

describe("Aggregate", () => {
  const rows: Json[] = [{ price: 10, tags: ["a"], u: { n: "x" } }, { price: 20, tags: ["b", "c"] }, { price: null, tags: ["d"], u: { n: "y" } }];
  it("fields: field values as lists, as, skipping empty ones", async () => {
    expect(await out0(Aggregate, rows, { fields: ["price", { field: "u.n", as: "names" }] })).toEqual({ price: [10, 20], names: ["x", "y"] });
  });
  it("keepMissing and mergeLists", async () => {
    expect(await out0(Aggregate, rows, { fields: ["price"], keepMissing: true })).toEqual({ price: [10, 20, null] });
    expect(await out0(Aggregate, rows, { fields: ["tags"], mergeLists: true })).toEqual({ tags: ["a", "b", "c", "d"] });
    expect(await out0(Aggregate, rows, { fields: ["tags"] })).toEqual({ tags: [["a"], ["b", "c"], ["d"]] });
  });
  it("all: all elements into one field, with field selection", async () => {
    expect(await out0(Aggregate, [{ a: 1, b: 2 }, { a: 3, b: 4 }], { mode: "all", into: "rows" })).toEqual({ rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] });
    expect(await out0(Aggregate, [{ a: 1, b: 2 }], { mode: "all", include: "only", fieldsList: ["a"] })).toEqual({ data: [{ a: 1 }] });
    expect(await out0(Aggregate, [{ a: 1, b: 2 }], { mode: "all", include: "except", fieldsList: "a" })).toEqual({ data: [{ b: 2 }] });
  });
  it("without fields, a clear error", async () => {
    await expect(run(Aggregate, rows, {})).rejects.toThrow(/fields/);
  });
});

describe("Split Out", () => {
  it("spreads an array from a field into elements", async () => {
    expect(await out0(SplitOut, { items: [1, 2, 3], x: 1 }, { field: "items" })).toEqual([1, 2, 3]);
    expect(await out0(SplitOut, { a: { list: ["p", "q"] } }, { field: "a.list" })).toEqual(["p", "q"]);
  });
  it("into wraps; include adds the remaining fields", async () => {
    const src = { id: 7, items: ["a", "b"], extra: true };
    expect(await out0(SplitOut, src, { field: "items", into: "item" })).toEqual([{ item: "a" }, { item: "b" }]);
    expect(await out0(SplitOut, src, { field: "items", include: "all" })).toEqual([
      { id: 7, extra: true, items: "a" },
      { id: 7, extra: true, items: "b" },
    ]);
    expect(await out0(SplitOut, src, { field: "items", include: "selected", fieldsToInclude: ["id"], into: "v" })).toEqual([
      { id: 7, v: "a" },
      { id: 7, v: "b" },
    ]);
  });
  it("an array of objects: the results are joined", async () => {
    expect(await out0(SplitOut, [{ l: [1] }, { l: [2, 3] }], { field: "l" })).toEqual([1, 2, 3]);
  });
  it("not an array is an error", async () => {
    await expect(run(SplitOut, { l: 5 }, { field: "l" })).rejects.toThrow('"l" is not an array');
    await expect(run(SplitOut, {}, { field: "l" })).rejects.toThrow(/not an array/);
  });
});

describe("Summarize", () => {
  const orders = [
    { rep: "ann", amount: 10, city: "A" },
    { rep: "bob", amount: "20", city: "A" },
    { rep: "ann", amount: 30, city: "B" },
    { rep: "ann", amount: null, city: "B" },
  ];
  const aggs = (a: Json[]) => ({ aggregations: a });
  it("all operations without grouping", async () => {
    const out = await out0(Summarize, orders, aggs([
      { field: "amount", op: "sum" },
      { field: "amount", op: "average", as: "avg" },
      { field: "amount", op: "min", as: "min" },
      { field: "amount", op: "max", as: "max" },
      { field: "rep", op: "count", as: "reps" },
      { field: "rep", op: "countUnique", as: "uniqueReps" },
      { field: "amount", op: "count", as: "withAmount" },
      { field: "rep", op: "append", as: "list" },
      { field: "city", op: "concatenate", as: "cities", separator: "|" },
      { op: "count", as: "rows" },
    ]));
    expect(out).toEqual({
      sum_amount: 60, avg: 20, min: 10, max: 30, reps: 4, uniqueReps: 2, withAmount: 3,
      list: ["ann", "bob", "ann", "ann"], cities: "A|A|B|B", rows: 4,
    });
  });
  it("grouping by a field and by several", async () => {
    expect(await out0(Summarize, orders, { ...aggs([{ field: "amount", op: "sum", as: "total" }]), groupBy: ["rep"] })).toEqual([
      { rep: "ann", total: 40 },
      { rep: "bob", total: 20 },
    ]);
    expect(await out0(Summarize, orders, { ...aggs([{ op: "count", as: "n" }]), groupBy: "rep, city" })).toEqual([
      { rep: "ann", city: "A", n: 1 },
      { rep: "bob", city: "A", n: 1 },
      { rep: "ann", city: "B", n: 2 },
    ]);
  });
  it("an empty list: sum = 0, the rest null", async () => {
    expect(await out0(Summarize, [], aggs([{ field: "x", op: "sum", as: "s" }, { field: "x", op: "average", as: "a" }, { field: "x", op: "max", as: "m" }]))).toEqual({ s: 0, a: null, m: null });
  });
  it("nested as and fields", async () => {
    expect(await out0(Summarize, [{ a: { b: 2 } }, { a: { b: 3 } }], aggs([{ field: "a.b", op: "sum", as: "stats.total" }]))).toEqual({ stats: { total: 5 } });
  });
  it("broken aggregations", async () => {
    await expect(run(Summarize, [], { aggregations: [] })).rejects.toThrow(/aggregations/);
    await expect(run(Summarize, [], { aggregations: [{ field: "a", op: "median" }] })).rejects.toThrow(/op must be one of/);
    await expect(run(Summarize, [], { aggregations: [5] })).rejects.toThrow(/must be an object/);
  });
});

describe("Rename Keys", () => {
  it("top level and a nested path; field order is preserved", async () => {
    const out = await out0(RenameKeys, { a: 1, b: { c: 2, d: 3 }, e: 4 }, { keys: { a: "A", "b.c": "C" } });
    expect(out).toEqual({ A: 1, b: { C: 2, d: 3 }, e: 4 });
    expect(Object.keys(out as object)).toEqual(["A", "b", "e"]);
    expect(Object.keys((out as { b: object }).b)).toEqual(["C", "d"]);
  });
  it("an array, missing keys, the input does not change", async () => {
    const input: Json[] = [{ a: 1 }, { z: 2 }];
    expect(await out0(RenameKeys, input, { keys: { a: "x" } })).toEqual([{ x: 1 }, { z: 2 }]);
    expect(input).toEqual([{ a: 1 }, { z: 2 }]);
  });
  it("broken parameters", async () => {
    await expect(run(RenameKeys, {}, { keys: [] })).rejects.toThrow(/object/);
    await expect(run(RenameKeys, {}, { keys: { a: "b.c" } })).rejects.toThrow(/without dots/);
    await expect(run(RenameKeys, {}, { keys: { a: "" } })).rejects.toThrow(/non-empty/);
  });
});

describe("Switch", () => {
  const rules: Json[] = [
    { operator: "lt", value: 10 },
    { operator: "lt", value: 100 },
    { field: "tag", operator: "eq", value: "vip" },
  ];
  it("the first matching rule wins", async () => {
    expect(await run(Switch, { n: 5 }, { field: "n", rules })).toEqual({ out0: { n: 5 } });
    expect(await run(Switch, { n: 50 }, { field: "n", rules })).toEqual({ out1: { n: 50 } });
  });
  it("all mode: for all matches; per-rule field", async () => {
    expect(await run(Switch, { n: 5, tag: "vip" }, { field: "n", rules, mode: "all" })).toEqual({
      out0: { n: 5, tag: "vip" }, out1: { n: 5, tag: "vip" }, out2: { n: 5, tag: "vip" },
    });
  });
  it("nothing matched: fallback", async () => {
    expect(await run(Switch, { n: 500 }, { field: "n", rules })).toEqual({ fallback: { n: 500 } });
  });
  it("rule errors", async () => {
    await expect(run(Switch, 1, { rules: [] })).rejects.toThrow(/non-empty/);
    await expect(run(Switch, 1, { rules: Array.from({ length: 5 }, () => ({ operator: "eq", value: 1 })) })).rejects.toThrow(/at most 4/);
    await expect(run(Switch, 1, { rules: [5] })).rejects.toThrow(/rules\[0\]/);
    await expect(run(Switch, 1, { rules: [{ operator: "regex", value: 1 }] })).rejects.toThrow(/Unknown operator/);
  });
  it("ports: 4 rules + fallback", () => {
    expect(Switch.ports.outputs.map((p) => p.id)).toEqual(["out0", "out1", "out2", "out3", "fallback"]);
  });
});

describe("Compare Datasets", () => {
  const A: Json[] = [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }];
  const B: Json[] = [{ id: 2, v: "b" }, { id: 3, v: "CHANGED" }, { id: 4, v: "d" }];
  // inputs holds only connected inputs: a missing key = the input is not connected
  const cmp = (params: Record<string, Json>, inputs: Record<string, Json> = { in0: A, in1: B }) =>
    (new CompareDatasets() as Block).run(inputs, resolveParams(CompareDatasets.params, params), { log() {}, signal: noSignal() });

  it("four outputs: A only, same, different, B only", async () => {
    expect(await cmp({ fieldA: "id", resolve: "a" })).toEqual({
      out0: [A[0]], out1: [A[1]], out2: [A[2]], out3: [B[2]],
    });
  });
  it("resolve = b takes the B version, both the keys/same/different structure", async () => {
    expect((await cmp({ fieldA: "id", resolve: "b" }))["out2"]).toEqual([B[1]]);
    expect((await cmp({ fieldA: "id" }))["out2"]).toEqual([
      { keys: { id: 3 }, same: { id: 3 }, different: { v: { inputA: "c", inputB: "CHANGED" } } },
    ]);
  });
  it("fieldB, skip, fuzzy", async () => {
    // the key fields are named differently (id / ref), noise is skipped in the comparison
    expect(await cmp({ fieldA: "id", fieldB: "ref", skip: ["id", "ref", "noise"] }, { in0: [{ id: 1, v: "a", noise: 99 }], in1: [{ ref: 1, v: "a", noise: 1 }] })).toEqual({
      out1: [{ id: 1, v: "a", noise: 99 }],
    });
    expect(await cmp({ fieldA: "id", fuzzy: true }, { in0: [{ id: 1 }], in1: [{ id: "1" }] })).toEqual({ out1: [{ id: 1 }] });
    expect(await cmp({ fieldA: "id" }, { in0: [{ id: 1 }], in1: [{ id: "1" }] })).toEqual({ out0: [{ id: 1 }], out3: [{ id: "1" }] });
  });
  it("empty outputs receive no data; one input is not connected", async () => {
    expect(await cmp({ fieldA: "id" }, { in0: [{ id: 1 }], in1: [{ id: 1 }] })).toEqual({ out1: [{ id: 1 }] });
    expect(await cmp({ fieldA: "id" }, { in0: A })).toEqual({ out0: A });
    expect(await cmp({ fieldA: "id" }, { in1: B })).toEqual({ out3: B });
  });
  it("no key field: an error pointing at the place", async () => {
    await expect(cmp({ fieldA: "id" }, { in0: [{ nope: 1 }], in1: B })).rejects.toThrow('field "id" not found in item 0 of input A');
    await expect(cmp({ fieldA: "id" }, { in0: A, in1: [{}] })).rejects.toThrow(/input B/);
  });
});

describe("Date & Time", () => {
  const dt = (params: Record<string, Json>, input?: Json) => out0(DateTime, input, params) as Promise<Record<string, Json>>;
  it("now returns ISO and is formatted", async () => {
    expect(((await dt({ operation: "now" }))["date"] as string)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(((await dt({ operation: "now", format: "YYYY" }))["date"] as string)).toMatch(/^\d{4}$/);
  });
  it("format: tokens, dates without a zone are UTC, ms numbers", async () => {
    expect((await dt({ operation: "format", value: "2024-03-05T07:08:09Z", format: "YYYY/MM/DD HH:mm:ss.SSS" }))["date"]).toBe("2024/03/05 07:08:09.000");
    expect((await dt({ operation: "format", value: "2024-03-05 07:08:09", format: "DD.MM.YYYY HH:mm" }))["date"]).toBe("05.03.2024 07:08");
    expect((await dt({ operation: "format", value: "2024-03-05", format: "YYYY-MM-DD" }))["date"]).toBe("2024-03-05");
    expect((await dt({ operation: "format", value: "{{ ts }}" }, { ts: 0 }))["date"]).toBe("1970-01-01T00:00:00.000Z");
    expect((await dt({ operation: "format", format: "YYYY" }, "2020-06-01"))["date"]).toBe("2020"); // value is empty -> the input
  });
  it("add / subtract: days, weeks, hours", async () => {
    const f = "YYYY-MM-DD HH:mm";
    expect((await dt({ operation: "add", value: "2024-01-30T10:00:00Z", unit: "days", amount: 3, format: f }))["date"]).toBe("2024-02-02 10:00");
    expect((await dt({ operation: "add", value: "2024-01-01T10:00:00Z", unit: "weeks", amount: 2, format: f }))["date"]).toBe("2024-01-15 10:00");
    expect((await dt({ operation: "subtract", value: "2024-01-01T10:00:00Z", unit: "hours", amount: 11, format: f }))["date"]).toBe("2023-12-31 23:00");
  });
  it("add of months/years clamps the day to the end of the month", async () => {
    const f = "YYYY-MM-DD";
    expect((await dt({ operation: "add", value: "2024-01-31", unit: "months", amount: 1, format: f }))["date"]).toBe("2024-02-29");
    expect((await dt({ operation: "add", value: "2023-01-31", unit: "months", amount: 1, format: f }))["date"]).toBe("2023-02-28");
    expect((await dt({ operation: "add", value: "2024-02-29", unit: "years", amount: 1, format: f }))["date"]).toBe("2025-02-28");
    expect((await dt({ operation: "subtract", value: "2024-03-31", unit: "months", amount: 1, format: f }))["date"]).toBe("2024-02-29");
    await expect(dt({ operation: "add", value: "2024-01-01", unit: "months", amount: 1.5 })).rejects.toThrow(/whole number/);
  });
  it("diff: whole units, negative values, calendar months and years", async () => {
    const d = (value: string, other: string, unit: string) => dt({ operation: "diff", value, other, unit }).then((r) => r["date"]);
    expect(await d("2024-01-01", "2024-01-11", "days")).toBe(10);
    expect(await d("2024-01-11", "2024-01-01", "days")).toBe(-10);
    expect(await d("2024-01-01T00:00:00Z", "2024-01-01T05:30:00Z", "hours")).toBe(5);
    expect(await d("2024-01-31", "2024-02-29", "months")).toBe(1); // consistent with add: 31 Jan + 1 month = 29 Feb
    expect(await d("2024-01-31", "2024-02-28", "months")).toBe(0);
    expect(await d("2024-01-15", "2024-03-15", "months")).toBe(2);
    expect(await d("2020-06-01", "2024-05-31", "years")).toBe(3);
    expect(await d("2024-03-15", "2024-01-15", "months")).toBe(-2);
    await expect(dt({ operation: "diff", value: "2024-01-01" })).rejects.toThrow(/other/);
  });
  it("extract", async () => {
    const x = (part: string) => dt({ operation: "extract", value: "2024-03-10T13:14:15Z", part }).then((r) => r["date"]); // Sunday
    expect([await x("year"), await x("month"), await x("day"), await x("hour"), await x("minute"), await x("second")]).toEqual([2024, 3, 10, 13, 14, 15]);
    expect(await x("weekday")).toBe(7);
    expect(await x("week")).toBe(10);
    expect((await dt({ operation: "extract", value: "2021-01-03", part: "week" }))["date"]).toBe(53); // ISO week of the previous year
  });
  it("round: down and up", async () => {
    const r = (value: string, unit: string, direction: string) => dt({ operation: "round", value, unit, direction }).then((x) => x["date"]);
    expect(await r("2024-03-10T13:14:15Z", "days", "down")).toBe("2024-03-10T00:00:00.000Z");
    expect(await r("2024-03-10T13:14:15Z", "days", "up")).toBe("2024-03-11T00:00:00.000Z");
    expect(await r("2024-03-10T00:00:00Z", "days", "up")).toBe("2024-03-10T00:00:00.000Z"); // already on the boundary
    expect(await r("2024-03-10T13:14:15Z", "hours", "down")).toBe("2024-03-10T13:00:00.000Z");
    expect(await r("2024-03-13T10:00:00Z", "weeks", "down")).toBe("2024-03-11T00:00:00.000Z"); // Monday
    expect(await r("2024-03-10T13:14:15Z", "months", "up")).toBe("2024-04-01T00:00:00.000Z");
    expect(await r("2024-03-10T13:14:15Z", "years", "down")).toBe("2024-01-01T00:00:00.000Z");
  });
  it("includeInput and a custom field name", async () => {
    expect(await dt({ operation: "format", value: "{{ at }}", format: "YYYY", field: "year", includeInput: true }, { at: "2024-01-01", keep: 1 })).toEqual({ at: "2024-01-01", keep: 1, year: "2024" });
    expect(await dt({ operation: "format", value: "2024-01-01", format: "YYYY", field: "a.b" })).toEqual({ a: { b: "2024" } });
  });
  it("errors: a broken date, operation, unit", async () => {
    await expect(dt({ operation: "format", value: "not a date" })).rejects.toThrow(/Invalid date/);
    await expect(dt({ operation: "format", value: "{{ x }}" }, { x: null })).rejects.toThrow(/Nothing to work with/);
    await expect(dt({ operation: "format", value: "{{ typo }}" }, { x: "2024-01-01" })).rejects.toThrow(/resolved to no value/);
    await expect(dt({ operation: "explode" })).rejects.toThrow(/Unknown operation/);
    await expect(dt({ operation: "add", value: "2024-01-01", unit: "decades" })).rejects.toThrow(/Unknown unit/);
  });
});

describe("Crypto", () => {
  const cr = (params: Record<string, Json>, input?: Json) => out0(Crypto, input, params) as Promise<Record<string, Json>>;
  it("hash matches the reference values", async () => {
    expect((await cr({ action: "hash", value: "abc" }))["value"]).toBe(createHash("sha256").update("abc").digest("hex"));
    expect((await cr({ action: "hash", value: "abc" }))["value"]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect((await cr({ action: "hash", algorithm: "md5", value: "{{ x }}" }, { x: "" }))["value"]).toBe("d41d8cd98f00b204e9800998ecf8427e"); // an empty string is a value, not "no value"
  });
  it("hash: encodings, a value from the input, objects as JSON", async () => {
    expect((await cr({ action: "hash", algorithm: "sha1", encoding: "base64" }, "abc"))["value"]).toBe(createHash("sha1").update("abc").digest("base64"));
    expect((await cr({ action: "hash", value: "{{ name }}" }, { name: "abc" }))["value"]).toBe(createHash("sha256").update("abc").digest("hex"));
    expect((await cr({ action: "hash" }, { a: 1 }))["value"]).toBe(createHash("sha256").update('{"a":1}').digest("hex"));
  });
  it("hmac matches the reference", async () => {
    expect((await cr({ action: "hmac", value: "The quick brown fox jumps over the lazy dog", secret: "key" }))["value"]).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
    expect((await cr({ action: "hmac", algorithm: "sha512", value: "x", secret: "k", encoding: "base64url" }))["value"]).toBe(createHmac("sha512", "k").update("x").digest("base64url"));
    await expect(cr({ action: "hmac", value: "x" })).rejects.toThrow(/secret/);
    await expect(cr({ action: "hash", value: "{{ nope }}" }, { a: 1 })).rejects.toThrow(/resolved to no value/);
  });
  it("generate: uuid and random bytes", async () => {
    expect((await cr({ action: "generate" }))["value"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const hex = (await cr({ action: "generate", kind: "bytes", length: 10 }))["value"] as string;
    expect(hex).toMatch(/^[0-9a-f]{20}$/);
    expect((await cr({ action: "generate", kind: "bytes", length: 10 }))["value"]).not.toBe(hex);
    await expect(cr({ action: "generate", kind: "bytes", length: 0 })).rejects.toThrow(/between/);
    await expect(cr({ action: "generate", kind: "bytes", length: 5000 })).rejects.toThrow(/between/);
  });
  it("encrypt -> decrypt returns the original text; salt and iv differ", async () => {
    const enc1 = (await cr({ action: "encrypt", value: "секрет 🔐", secret: "pw" }))["value"] as string;
    const enc2 = (await cr({ action: "encrypt", value: "секрет 🔐", secret: "pw" }))["value"] as string;
    expect(enc1).toMatch(/^v1\./);
    expect(enc1).not.toBe(enc2);
    expect((await cr({ action: "decrypt", value: enc1, secret: "pw" }))["value"]).toBe("секрет 🔐");
  });
  it("decrypt: a foreign password, tampering, not encrypted, no password", async () => {
    const enc = (await cr({ action: "encrypt", value: "data", secret: "pw" }))["value"] as string;
    await expect(cr({ action: "decrypt", value: enc, secret: "other" })).rejects.toThrow(/wrong passphrase/);
    const parts = enc.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    await expect(cr({ action: "decrypt", value: parts.join("."), secret: "pw" })).rejects.toThrow(/wrong passphrase/);
    await expect(cr({ action: "decrypt", value: "plain text", secret: "pw" })).rejects.toThrow(/not an encrypted/);
    await expect(cr({ action: "encrypt", value: "x" })).rejects.toThrow(/passphrase/);
    await expect(cr({ action: "decrypt", value: enc })).rejects.toThrow(/passphrase/);
  });
  it("includeInput, field name, unknown values", async () => {
    expect(await cr({ action: "hash", value: "abc", field: "sha", includeInput: true }, { id: 1 })).toMatchObject({ id: 1, sha: expect.any(String) });
    await expect(cr({ action: "nope" })).rejects.toThrow(/Unknown action/);
    await expect(cr({ action: "hash", algorithm: "md2" })).rejects.toThrow(/Unknown algorithm/);
    await expect(cr({ action: "hash", encoding: "utf16" })).rejects.toThrow(/Unknown encoding/);
  });
});

describe("JWT", () => {
  const jwt = (params: Record<string, Json>, input?: Json) => out0(Jwt, input, params) as Promise<Record<string, Json>>;
  const secret = "s3cret";
  const forge = (header: object, payload: object, key = secret, alg = "sha256") => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const data = `${b(header)}.${b(payload)}`;
    return `${data}.${createHmac(alg, key).update(data).digest("base64url")}`;
  };

  it("sign gives a valid HS256 token (checked by an independent implementation)", async () => {
    const { token } = (await jwt({ operation: "sign", secret, payload: { sub: "u1", name: "{{ name }}" } }, { name: "Ann" })) as { token: string };
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload).toMatchObject({ sub: "u1", name: "Ann", iat: expect.any(Number) });
    expect(s).toBe(createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url"));
  });
  it("sign: expiresInSeconds and other algorithms", async () => {
    const { token } = (await jwt({ operation: "sign", secret, algorithm: "HS512", expiresInSeconds: 60 })) as { token: string };
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(payload.exp - payload.iat).toBe(60);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).alg).toBe("HS512");
    expect(await jwt({ operation: "verify", secret, algorithm: "HS512", token })).toMatchObject({ valid: true });
  });
  it("sign -> verify; the token is taken from the input (a string or the token field)", async () => {
    const { token } = (await jwt({ operation: "sign", secret, payload: { a: 1 } })) as { token: string };
    expect(await jwt({ operation: "verify", secret }, token)).toMatchObject({ valid: true, payload: { a: 1 } });
    expect(await jwt({ operation: "verify", secret }, { token })).toMatchObject({ valid: true });
    expect(await jwt({ operation: "verify", secret, token: "{{ t }}" }, { t: token })).toMatchObject({ valid: true });
  });
  it("verify rejects: a foreign secret, tampering, another algorithm, alg none, expired and not yet valid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = forge({ alg: "HS256", typ: "JWT" }, { a: 1, exp: now + 100 });
    expect(await jwt({ operation: "verify", secret }, good)).toMatchObject({ valid: true });
    await expect(jwt({ operation: "verify", secret: "wrong" }, good)).rejects.toThrow(/invalid signature/);
    const [h, , s] = good.split(".");
    const evil = `${h}.${Buffer.from(JSON.stringify({ a: 1, admin: true })).toString("base64url")}.${s}`;
    await expect(jwt({ operation: "verify", secret }, evil)).rejects.toThrow(/invalid signature/);
    await expect(jwt({ operation: "verify", secret, algorithm: "HS512" }, good)).rejects.toThrow(/algorithm mismatch/);
    await expect(jwt({ operation: "verify", secret }, `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`)).rejects.toThrow(/algorithm mismatch/);
    await expect(jwt({ operation: "verify", secret }, forge({ alg: "HS256" }, { exp: now - 1 }))).rejects.toThrow(/expired/);
    await expect(jwt({ operation: "verify", secret }, forge({ alg: "HS256" }, { nbf: now + 1000 }))).rejects.toThrow(/not active/);
  });
  it("decode does not verify the signature", async () => {
    expect(await jwt({ operation: "decode" }, forge({ alg: "HS256", typ: "JWT" }, { x: 1 }, "any"))).toEqual({
      header: { alg: "HS256", typ: "JWT" },
      payload: { x: 1 },
    });
  });
  it("garbage tokens and a missing secret", async () => {
    for (const bad of ["abc", "a.b", "a.b.c.d", "!!!.???.***"]) await expect(jwt({ operation: "decode" }, bad), bad).rejects.toThrow(/malformed/);
    await expect(jwt({ operation: "sign" })).rejects.toThrow(/secret/);
    await expect(jwt({ operation: "verify" }, forge({ alg: "HS256" }, {}))).rejects.toThrow(/secret/);
    await expect(jwt({ operation: "sign", secret, payload: [1] })).rejects.toThrow(/payload/);
  });
});

describe("Wait", () => {
  it("waits the given time and passes data on", async () => {
    const t = Date.now();
    expect(await out0(Wait, { a: 1 }, { amount: 0.08, unit: "seconds" })).toEqual({ a: 1 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(70);
  });
  it("zero: immediately", async () => {
    expect(await out0(Wait, 5, { amount: 0 })).toBe(5);
  });
  it("interrupted by cancellation, including before the start", async () => {
    const ac = new AbortController();
    const p = run(Wait, 1, { amount: 30 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const t = Date.now();
    await expect(p).rejects.toThrow("Aborted");
    expect(Date.now() - t).toBeLessThan(1000);
    const done = new AbortController();
    done.abort();
    await expect(run(Wait, 1, { amount: 1 }, { signal: done.signal })).rejects.toThrow("Aborted");
  });
  it("run limit and broken values", async () => {
    await expect(run(Wait, 1, { amount: 6, unit: "minutes" })).rejects.toThrow(/exceeds the run limit/);
    await expect(run(Wait, 1, { amount: -1 })).rejects.toThrow(/non-negative/);
    await expect(run(Wait, 1, { unit: "days" })).rejects.toThrow(/Unknown unit/);
  });
});

describe("Stop and Error", () => {
  it("throws text with data substituted", async () => {
    await expect(run(StopAndError, { id: 7 }, { message: "Order {{ id }} rejected" })).rejects.toThrow("Order 7 rejected");
    await expect(run(StopAndError, 1)).rejects.toThrow("Workflow stopped");
  });
  it("type object: the message is the object's JSON", async () => {
    await expect(run(StopAndError, { code: 42 }, { errorType: "object", errorObject: { code: "{{ code }}", fixed: "x" } })).rejects.toThrow('{"code":42,"fixed":"x"}');
  });
  it("terminal block: no outputs", () => {
    expect(StopAndError.ports.outputs).toEqual([]);
  });
});

describe("Webhook / Respond to Webhook", () => {
  it("normalizeWebhookPath", () => {
    expect(normalizeWebhookPath("/orders/new/")).toBe("orders/new");
    expect(normalizeWebhookPath("a.b_c-d~e")).toBe("a.b_c-d~e");
    for (const bad of ["", "/", "a b", "a//b", "../x", "a?b", "a#b", "ä"]) expect(normalizeWebhookPath(bad), bad).toBeNull();
  });
  it("webhook(): path and method; a broken path is an error", () => {
    expect(Webhook.webhook({ path: "/x/", method: "GET" })).toEqual({ path: "x", method: "GET" });
    expect(Webhook.webhook({ path: "x" })).toEqual({ path: "x", method: "POST" });
    expect(() => Webhook.webhook({ path: "a b" })).toThrow(/Invalid webhook path/);
  });
  it("run returns the request data; without an event an error, there is no invented request", async () => {
    const payload = { method: "POST", path: "x", query: { a: "1" }, headers: {}, body: { ok: true } };
    expect(await out0(Webhook, undefined, { path: "x" }, { triggerData: payload })).toEqual(payload);
    await expect(out0(Webhook, undefined, { path: "x", method: "GET" })).rejects.toThrow(/Webhook has no event data/);
  });
  it("trigger properties", () => {
    expect([Webhook.isTrigger, Webhook.autoTrigger, Webhook.ports.inputs.length]).toEqual([true, true, 0]);
  });
  it("respond: the body is the input by default; parameters, templates, headers as strings", async () => {
    expect(await run(RespondToWebhook, { a: 1 })).toEqual({ response: { status: 200, headers: {}, body: { a: 1 } } });
    expect(await run(RespondToWebhook, { id: 5 }, { status: 201, body: { created: "{{ id }}" }, headers: { "X-N": 5 } })).toEqual({
      response: { status: 201, headers: { "X-N": "5" }, body: { created: 5 } },
    });
    await expect(run(RespondToWebhook, 1, { headers: [1] })).rejects.toThrow(/headers/);
    expect(RespondToWebhook.ports.outputs).toEqual([]);
  });
});

describe("cloneJson", () => {
  it("deep copy", () => {
    const a = { x: [1, { y: 2 }] };
    const b = cloneJson(a);
    (b.x[1] as { y: number }).y = 9;
    expect(a).toEqual({ x: [1, { y: 2 }] });
  });
});

describe("resolveInputsExpressions / resolveParamExpressions / hasExpression", () => {
  const inputs = { in0: { n: 5, s: "text", o: { k: [1, 2] } }, in1: ["x"] } as unknown as Record<string, Json>;
  it("a whole expression keeps its type, in text it is a string", () => {
    expect(resolveInputsExpressions("{{ inputs.in0.n }}", inputs)).toBe(5);
    expect(resolveInputsExpressions("{{inputs.in0.o}}", inputs)).toEqual({ k: [1, 2] });
    expect(resolveInputsExpressions("n={{ inputs.in0.n }}, s={{ inputs.in0.s }}, o={{ inputs.in0.o.k }}", inputs)).toBe('n=5, s=text, o=[1,2]');
    expect(resolveInputsExpressions("{{ inputs.in1.0 }}", inputs)).toBe("x");
    expect(resolveInputsExpressions("{{ inputs }}", inputs)).toEqual(inputs);
  });
  it("no value: null / an empty string; foreign templates are left untouched", () => {
    expect(resolveInputsExpressions("{{ inputs.in9.x }}", inputs)).toBeNull();
    expect(resolveInputsExpressions("[{{ inputs.in0.nope }}]", inputs)).toBe("[]");
    expect(resolveInputsExpressions("{{ n }} {{ $json.n }} {{ inputsX.in0 }}", inputs)).toBe("{{ n }} {{ $json.n }} {{ inputsX.in0 }}");
  });
  it("spaces around an expression are part of the text (the type is not kept)", () => {
    expect(resolveInputsExpressions("{{ inputs.in0.n }}\n", inputs)).toBe("5\n");
    expect(resolveInputsExpressions(" {{ inputs.in0.n }}", inputs)).toBe(" 5");
  });
  it("recursion over arrays and objects; other types do not change", () => {
    expect(resolveInputsExpressions({ a: ["{{ inputs.in0.n }}", 1, true, null, { b: "{{ inputs.in0.s }}" }] }, inputs)).toEqual({ a: [5, 1, true, null, { b: "text" }] });
  });
  it("does not confuse a path with dangerous keys (the prototype is inaccessible)", () => {
    expect(resolveInputsExpressions("{{ inputs.in0.__proto__ }}", inputs)).toBeNull();
    expect(resolveInputsExpressions("{{ inputs.in0.constructor }}", inputs)).toBeNull();
  });
  it("resolveParamExpressions skips parameters with expressions: false", () => {
    const schema = [{ name: "code", type: "string", expressions: false }, { name: "x", type: "string" }] as import("@fl0w/schema").ParamSchema[];
    expect(resolveParamExpressions(schema, { code: "{{ inputs.in0.n }}", x: "{{ inputs.in0.n }}", extra: "{{ inputs.in0.s }}" }, inputs)).toEqual({
      code: "{{ inputs.in0.n }}",
      x: "5", // a string parameter: a number is converted to text
      extra: "text",
    });
    expect(CodeBlock.params.find((p) => p.name === "code")?.expressions).toBe(false);
    expect(Shell.params.find((p) => p.name === "script")?.expressions).toBe(false);
  });
  it("hasExpression", () => {
    expect(hasExpression("{{ x }}")).toBe(true);
    expect(hasExpression("a {{inputs.in0.x}} b")).toBe(true);
    expect(hasExpression("{ x }")).toBe(false);
    expect(hasExpression(5)).toBe(false);
    expect(hasExpression(undefined)).toBe(false);
  });
  it("validateParams: expressions defer the type check only with allowExpressions", () => {
    const schema = [
      { name: "n", type: "number", min: 1 },
      { name: "f", type: "boolean" },
      { name: "m", type: "enum", options: [{ value: "a" }] },
    ] as import("@fl0w/schema").ParamSchema[];
    const v = { n: "{{ inputs.in0.n }}", f: "{{ inputs.in0.f }}", m: "{{ inputs.in0.m }}" };
    expect(validateParams(schema, v).map((i) => i.code).sort()).toEqual(["enum", "type", "type"]);
    expect(validateParams(schema, v, { allowExpressions: true })).toEqual([]);
    expect(validateParams(schema, { n: "abc" }, { allowExpressions: true }).map((i) => i.code)).toEqual(["type"]); // not an expression: it is checked
  });
});

describe("datetime: a number via an expression", () => {
  it("a string of digits (the result of {{ inputs... }}) is epoch milliseconds", async () => {
    const r = (await out0(DateTime, undefined, { operation: "format", value: "1700000000000", format: "YYYY-MM-DD" })) as Json;
    expect(JSON.stringify(r)).toContain("2023-11-14");
  });
});

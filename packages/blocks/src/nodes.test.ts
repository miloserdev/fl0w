import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { Aggregate } from "./aggregate";
import type { Block, RunContext } from "./block";
import { CompareDatasets } from "./compare-datasets";
import { Crypto } from "./crypto";
import { DateTime } from "./datetime";
import { Filter } from "./filter";
import { cloneJson, deletePath, interpolate, resolveTemplates, setPath, toList } from "./json-path";
import { Jwt } from "./jwt";
import { Limit } from "./limit";
import { compareJson, stableKey } from "./list-utils";
import { ManualTrigger } from "./manual";
import { NoOp } from "./noop";
import { resolveParams } from "./params";
import { RemoveDuplicates } from "./remove-duplicates";
import { RenameKeys } from "./rename-keys";
import { RespondToWebhook } from "./respond-to-webhook";
import { SetFields } from "./set";
import { Sort } from "./sort";
import { SplitOut } from "./split-out";
import { StopAndError } from "./stop-and-error";
import { Summarize } from "./summarize";
import { Switch } from "./switch";
import { Wait } from "./wait";
import { Webhook, normalizeWebhookPath } from "./webhook";

type Cls = { new (): Block; params: import("@fl0w/schema").ParamSchema[] };
const noSignal = () => new AbortController().signal;
/** Запускает блок так же, как движок: параметры дополняются default'ами. */
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

describe("утилиты путей и шаблонов", () => {
  it("setPath создаёт вложенные объекты и перезаписывает не-объекты", () => {
    const o: { [k: string]: Json } = { a: 1 };
    setPath(o, "a.b.c", 2);
    setPath(o, "x", 3);
    expect(o).toEqual({ a: { b: { c: 2 } }, x: 3 });
  });
  it("setPath/deletePath не позволяют отравить прототип", () => {
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
  it("interpolate: один шаблон сохраняет тип, внутри текста — строка", () => {
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
    // пробелы и переводы строк ВОКРУГ шаблона — часть текста: тип не сохраняется, пробелы не теряются
    expect(interpolate("{{ n }}\n", data)).toBe("5\n");
    expect(interpolate(" {{ n }} ", data)).toBe(" 5 ");
    expect(interpolate("{{ user.name }}\n", data)).toBe("Ann\n");
  });
  it("resolveTemplates обходит вложенные значения", () => {
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
  it("noop пропускает данные как есть", async () => {
    expect(await out0(NoOp, { a: [1] })).toEqual({ a: [1] });
    expect(await out0(NoOp, undefined)).toBeNull();
  });
  it("manual отдаёт метку времени и не имеет входов", async () => {
    expect(ManualTrigger.ports.inputs).toEqual([]);
    expect(ManualTrigger.isTrigger).toBe(true);
    expect(ManualTrigger.autoTrigger).toBe(false);
    expect((await out0(ManualTrigger, undefined) as { triggeredAt: string }).triggeredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("Edit Fields (Set)", () => {
  it("задаёт, перезаписывает, вкладывает и подставляет шаблоны с типами", async () => {
    const out = await out0(SetFields, { name: "Ann", n: 2 }, {
      fields: { greeting: "Hello {{ name }}", double: "{{ n }}", "meta.source": "api", name: "Bob" },
    });
    expect(out).toEqual({ name: "Bob", n: 2, greeting: "Hello Ann", double: 2, meta: { source: "api" } });
  });
  it("шаблоны читают исходные данные, а не частично изменённые", async () => {
    expect(await out0(SetFields, { a: 1 }, { fields: { a: 2, b: "{{ a }}" } })).toEqual({ a: 2, b: 1 });
  });
  it("keepOnlySet и remove", async () => {
    expect(await out0(SetFields, { a: 1, b: 2 }, { fields: { c: "{{ a }}" }, keepOnlySet: true })).toEqual({ c: 1 });
    expect(await out0(SetFields, { a: 1, b: { x: 1, y: 2 } }, { remove: ["a", "b.x", "nope"] })).toEqual({ b: { y: 2 } });
    expect(await out0(SetFields, { a: 1, b: 2 }, { remove: "a, b" })).toEqual({});
  });
  it("массив обрабатывается поэлементно, вход не мутируется", async () => {
    const input = [{ n: 1 }, { n: 2 }];
    expect(await out0(SetFields, input, { fields: { sq: "{{ n }}", tag: "x" } })).toEqual([
      { n: 1, sq: 1, tag: "x" },
      { n: 2, sq: 2, tag: "x" },
    ]);
    expect(input).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("ошибки: не объект, кривые fields, опасный путь", async () => {
    await expect(run(SetFields, 5, { fields: { a: 1 } })).rejects.toThrow(/object/);
    await expect(run(SetFields, {}, { fields: [1] })).rejects.toThrow(/object of/);
    await expect(run(SetFields, {}, { fields: { "__proto__.x": 1 } })).rejects.toThrow(/Invalid path/);
    expect(await out0(SetFields, 5, { fields: { a: 1 }, keepOnlySet: true })).toEqual({ a: 1 }); // база не нужна
  });
});

describe("Filter", () => {
  const items = [{ n: 1 }, { n: 5 }, { n: 9 }];
  it("kept / discarded", async () => {
    expect(await run(Filter, items, { field: "n", operator: "gt", value: 4 })).toEqual({ out0: [{ n: 5 }, { n: 9 }], out1: [{ n: 1 }] });
  });
  it("пустой выход данных не получает", async () => {
    expect(await run(Filter, items, { field: "n", operator: "gt", value: 100 })).toEqual({ out1: items });
    expect(await run(Filter, items, { field: "n", operator: "exists" })).toEqual({ out0: items });
    expect(await run(Filter, [], { field: "n" })).toEqual({});
  });
  it("одиночное значение уходит целиком", async () => {
    expect(await run(Filter, { n: 5 }, { field: "n", operator: "gt", value: 1 })).toEqual({ out0: { n: 5 } });
    expect(await run(Filter, { n: 0 }, { field: "n", operator: "gt", value: 1 })).toEqual({ out1: { n: 0 } });
  });
  it("path и отсутствующий путь", async () => {
    expect(await run(Filter, { rows: items }, { path: "rows", field: "n", operator: "lt", value: 2 })).toEqual({
      out0: [{ n: 1 }],
      out1: [{ n: 5 }, { n: 9 }],
    });
    await expect(run(Filter, {}, { path: "rows" })).rejects.toThrow('nothing found at "rows"');
  });
});

describe("Sort", () => {
  it("числа по возрастанию и убыванию (числовое, а не строковое сравнение)", async () => {
    expect(await out0(Sort, [10, 9, 100, 1])).toEqual([1, 9, 10, 100]);
    expect(await out0(Sort, [10, 9, 100, 1], { order: "desc" })).toEqual([100, 10, 9, 1]);
  });
  it("по полю, по нескольким полям и разный порядок", async () => {
    const people = [
      { name: "b", age: 30 },
      { name: "a", age: 30 },
      { name: "c", age: 20 },
    ];
    expect(await out0(Sort, people, { fields: ["age"] })).toEqual([people[2], people[0], people[1]]); // устойчивость
    expect(await out0(Sort, people, { fields: [{ field: "age", order: "desc" }, "name"] })).toEqual([people[1], people[0], people[2]]);
  });
  it("смешанные типы и отсутствующие значения уходят в конец", async () => {
    expect(await out0(Sort, [{ v: null }, { v: "b" }, {}, { v: 2 }, { v: "a" }], { fields: ["v"] })).toEqual([
      { v: 2 }, { v: "a" }, { v: "b" }, { v: null }, {},
    ]);
  });
  it("random — перестановка тех же элементов; вход не меняется", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = (await out0(Sort, input, { mode: "random" })) as number[];
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("кривые fields", async () => {
    await expect(run(Sort, [1], { fields: [5] })).rejects.toThrow(/fields/);
  });
});

describe("Limit", () => {
  it("first / last / ноль / больше длины", async () => {
    expect(await out0(Limit, [1, 2, 3, 4], { count: 2 })).toEqual([1, 2]);
    expect(await out0(Limit, [1, 2, 3, 4], { count: 2, keep: "last" })).toEqual([3, 4]);
    expect(await out0(Limit, [1, 2], { count: 0 })).toEqual([]);
    expect(await out0(Limit, [1, 2], { count: 0, keep: "last" })).toEqual([]);
    expect(await out0(Limit, [1, 2], { count: 10 })).toEqual([1, 2]);
    expect(await out0(Limit, { rows: [1, 2, 3] }, { path: "rows", count: 1 })).toEqual([1]);
  });
});

describe("Remove Duplicates", () => {
  it("по всему значению: порядок ключей не важен, остаётся первое", async () => {
    expect(await out0(RemoveDuplicates, [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1 }, 1, "1", 1])).toEqual([{ a: 1, b: 2 }, { a: 1 }, 1, "1"]);
  });
  it("по полям", async () => {
    const rows = [{ id: 1, v: "a" }, { id: 2, v: "a" }, { id: 1, v: "b" }];
    expect(await out0(RemoveDuplicates, rows, { compare: "fields", fields: ["id"] })).toEqual([rows[0], rows[1]]);
    expect(await out0(RemoveDuplicates, rows, { compare: "fields", fields: "v" })).toEqual([rows[0], rows[2]]);
  });
  it("compare=fields без полей — ошибка", async () => {
    await expect(run(RemoveDuplicates, [1], { compare: "fields" })).rejects.toThrow(/fields/);
  });
});

describe("Aggregate", () => {
  const rows: Json[] = [{ price: 10, tags: ["a"], u: { n: "x" } }, { price: 20, tags: ["b", "c"] }, { price: null, tags: ["d"], u: { n: "y" } }];
  it("fields: значения полей списками, as, пропуск пустых", async () => {
    expect(await out0(Aggregate, rows, { fields: ["price", { field: "u.n", as: "names" }] })).toEqual({ price: [10, 20], names: ["x", "y"] });
  });
  it("keepMissing и mergeLists", async () => {
    expect(await out0(Aggregate, rows, { fields: ["price"], keepMissing: true })).toEqual({ price: [10, 20, null] });
    expect(await out0(Aggregate, rows, { fields: ["tags"], mergeLists: true })).toEqual({ tags: ["a", "b", "c", "d"] });
    expect(await out0(Aggregate, rows, { fields: ["tags"] })).toEqual({ tags: [["a"], ["b", "c"], ["d"]] });
  });
  it("all: все элементы в одно поле, с отбором полей", async () => {
    expect(await out0(Aggregate, [{ a: 1, b: 2 }, { a: 3, b: 4 }], { mode: "all", into: "rows" })).toEqual({ rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] });
    expect(await out0(Aggregate, [{ a: 1, b: 2 }], { mode: "all", include: "only", fieldsList: ["a"] })).toEqual({ data: [{ a: 1 }] });
    expect(await out0(Aggregate, [{ a: 1, b: 2 }], { mode: "all", include: "except", fieldsList: "a" })).toEqual({ data: [{ b: 2 }] });
  });
  it("без fields — понятная ошибка", async () => {
    await expect(run(Aggregate, rows, {})).rejects.toThrow(/fields/);
  });
});

describe("Split Out", () => {
  it("раскладывает массив из поля на элементы", async () => {
    expect(await out0(SplitOut, { items: [1, 2, 3], x: 1 }, { field: "items" })).toEqual([1, 2, 3]);
    expect(await out0(SplitOut, { a: { list: ["p", "q"] } }, { field: "a.list" })).toEqual(["p", "q"]);
  });
  it("into оборачивает; include добавляет остальные поля", async () => {
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
  it("массив объектов — результаты склеиваются", async () => {
    expect(await out0(SplitOut, [{ l: [1] }, { l: [2, 3] }], { field: "l" })).toEqual([1, 2, 3]);
  });
  it("не массив — ошибка", async () => {
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
  it("все операции без группировки", async () => {
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
  it("группировка по полю и по нескольким", async () => {
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
  it("пустой список: sum = 0, остальное null", async () => {
    expect(await out0(Summarize, [], aggs([{ field: "x", op: "sum", as: "s" }, { field: "x", op: "average", as: "a" }, { field: "x", op: "max", as: "m" }]))).toEqual({ s: 0, a: null, m: null });
  });
  it("вложенные as и поля", async () => {
    expect(await out0(Summarize, [{ a: { b: 2 } }, { a: { b: 3 } }], aggs([{ field: "a.b", op: "sum", as: "stats.total" }]))).toEqual({ stats: { total: 5 } });
  });
  it("кривые aggregations", async () => {
    await expect(run(Summarize, [], { aggregations: [] })).rejects.toThrow(/aggregations/);
    await expect(run(Summarize, [], { aggregations: [{ field: "a", op: "median" }] })).rejects.toThrow(/op must be one of/);
    await expect(run(Summarize, [], { aggregations: [5] })).rejects.toThrow(/must be an object/);
  });
});

describe("Rename Keys", () => {
  it("верхний уровень и вложенный путь; порядок полей сохраняется", async () => {
    const out = await out0(RenameKeys, { a: 1, b: { c: 2, d: 3 }, e: 4 }, { keys: { a: "A", "b.c": "C" } });
    expect(out).toEqual({ A: 1, b: { C: 2, d: 3 }, e: 4 });
    expect(Object.keys(out as object)).toEqual(["A", "b", "e"]);
    expect(Object.keys((out as { b: object }).b)).toEqual(["C", "d"]);
  });
  it("массив, отсутствующие ключи, вход не меняется", async () => {
    const input: Json[] = [{ a: 1 }, { z: 2 }];
    expect(await out0(RenameKeys, input, { keys: { a: "x" } })).toEqual([{ x: 1 }, { z: 2 }]);
    expect(input).toEqual([{ a: 1 }, { z: 2 }]);
  });
  it("кривые параметры", async () => {
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
  it("побеждает первое совпавшее правило", async () => {
    expect(await run(Switch, { n: 5 }, { field: "n", rules })).toEqual({ out0: { n: 5 } });
    expect(await run(Switch, { n: 50 }, { field: "n", rules })).toEqual({ out1: { n: 50 } });
  });
  it("режим all — на все совпавшие; per-rule field", async () => {
    expect(await run(Switch, { n: 5, tag: "vip" }, { field: "n", rules, mode: "all" })).toEqual({
      out0: { n: 5, tag: "vip" }, out1: { n: 5, tag: "vip" }, out2: { n: 5, tag: "vip" },
    });
  });
  it("ничего не подошло — fallback", async () => {
    expect(await run(Switch, { n: 500 }, { field: "n", rules })).toEqual({ fallback: { n: 500 } });
  });
  it("ошибки правил", async () => {
    await expect(run(Switch, 1, { rules: [] })).rejects.toThrow(/non-empty/);
    await expect(run(Switch, 1, { rules: Array.from({ length: 5 }, () => ({ operator: "eq", value: 1 })) })).rejects.toThrow(/at most 4/);
    await expect(run(Switch, 1, { rules: [5] })).rejects.toThrow(/rules\[0\]/);
    await expect(run(Switch, 1, { rules: [{ operator: "regex", value: 1 }] })).rejects.toThrow(/Unknown operator/);
  });
  it("порты: 4 правила + fallback", () => {
    expect(Switch.ports.outputs.map((p) => p.id)).toEqual(["out0", "out1", "out2", "out3", "fallback"]);
  });
});

describe("Compare Datasets", () => {
  const A: Json[] = [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }];
  const B: Json[] = [{ id: 2, v: "b" }, { id: 3, v: "CHANGED" }, { id: 4, v: "d" }];
  // inputs — только подключённые входы: отсутствующий ключ = вход не подключён
  const cmp = (params: Record<string, Json>, inputs: Record<string, Json> = { in0: A, in1: B }) =>
    (new CompareDatasets() as Block).run(inputs, resolveParams(CompareDatasets.params, params), { log() {}, signal: noSignal() });

  it("четыре выхода: A only, same, different, B only", async () => {
    expect(await cmp({ fieldA: "id", resolve: "a" })).toEqual({
      out0: [A[0]], out1: [A[1]], out2: [A[2]], out3: [B[2]],
    });
  });
  it("resolve = b берёт версию B, both — структуру keys/same/different", async () => {
    expect((await cmp({ fieldA: "id", resolve: "b" }))["out2"]).toEqual([B[1]]);
    expect((await cmp({ fieldA: "id" }))["out2"]).toEqual([
      { keys: { id: 3 }, same: { id: 3 }, different: { v: { inputA: "c", inputB: "CHANGED" } } },
    ]);
  });
  it("fieldB, skip, fuzzy", async () => {
    // ключевые поля называются по-разному (id / ref), шум пропускаем при сравнении
    expect(await cmp({ fieldA: "id", fieldB: "ref", skip: ["id", "ref", "noise"] }, { in0: [{ id: 1, v: "a", noise: 99 }], in1: [{ ref: 1, v: "a", noise: 1 }] })).toEqual({
      out1: [{ id: 1, v: "a", noise: 99 }],
    });
    expect(await cmp({ fieldA: "id", fuzzy: true }, { in0: [{ id: 1 }], in1: [{ id: "1" }] })).toEqual({ out1: [{ id: 1 }] });
    expect(await cmp({ fieldA: "id" }, { in0: [{ id: 1 }], in1: [{ id: "1" }] })).toEqual({ out0: [{ id: 1 }], out3: [{ id: "1" }] });
  });
  it("пустые выходы данных не получают; один вход не подключён", async () => {
    expect(await cmp({ fieldA: "id" }, { in0: [{ id: 1 }], in1: [{ id: 1 }] })).toEqual({ out1: [{ id: 1 }] });
    expect(await cmp({ fieldA: "id" }, { in0: A })).toEqual({ out0: A });
    expect(await cmp({ fieldA: "id" }, { in1: B })).toEqual({ out3: B });
  });
  it("нет ключевого поля — ошибка с указанием места", async () => {
    await expect(cmp({ fieldA: "id" }, { in0: [{ nope: 1 }], in1: B })).rejects.toThrow('field "id" not found in item 0 of input A');
    await expect(cmp({ fieldA: "id" }, { in0: A, in1: [{}] })).rejects.toThrow(/input B/);
  });
});

describe("Date & Time", () => {
  const dt = (params: Record<string, Json>, input?: Json) => out0(DateTime, input, params) as Promise<Record<string, Json>>;
  it("now отдаёт ISO и форматируется", async () => {
    expect(((await dt({ operation: "now" }))["date"] as string)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(((await dt({ operation: "now", format: "YYYY" }))["date"] as string)).toMatch(/^\d{4}$/);
  });
  it("format: токены, даты без пояса — UTC, мс-числа", async () => {
    expect((await dt({ operation: "format", value: "2024-03-05T07:08:09Z", format: "YYYY/MM/DD HH:mm:ss.SSS" }))["date"]).toBe("2024/03/05 07:08:09.000");
    expect((await dt({ operation: "format", value: "2024-03-05 07:08:09", format: "DD.MM.YYYY HH:mm" }))["date"]).toBe("05.03.2024 07:08");
    expect((await dt({ operation: "format", value: "2024-03-05", format: "YYYY-MM-DD" }))["date"]).toBe("2024-03-05");
    expect((await dt({ operation: "format", value: "{{ ts }}" }, { ts: 0 }))["date"]).toBe("1970-01-01T00:00:00.000Z");
    expect((await dt({ operation: "format", format: "YYYY" }, "2020-06-01"))["date"]).toBe("2020"); // value пусто → вход
  });
  it("add / subtract: дни, недели, часы", async () => {
    const f = "YYYY-MM-DD HH:mm";
    expect((await dt({ operation: "add", value: "2024-01-30T10:00:00Z", unit: "days", amount: 3, format: f }))["date"]).toBe("2024-02-02 10:00");
    expect((await dt({ operation: "add", value: "2024-01-01T10:00:00Z", unit: "weeks", amount: 2, format: f }))["date"]).toBe("2024-01-15 10:00");
    expect((await dt({ operation: "subtract", value: "2024-01-01T10:00:00Z", unit: "hours", amount: 11, format: f }))["date"]).toBe("2023-12-31 23:00");
  });
  it("add месяцев/лет прижимает день к концу месяца", async () => {
    const f = "YYYY-MM-DD";
    expect((await dt({ operation: "add", value: "2024-01-31", unit: "months", amount: 1, format: f }))["date"]).toBe("2024-02-29");
    expect((await dt({ operation: "add", value: "2023-01-31", unit: "months", amount: 1, format: f }))["date"]).toBe("2023-02-28");
    expect((await dt({ operation: "add", value: "2024-02-29", unit: "years", amount: 1, format: f }))["date"]).toBe("2025-02-28");
    expect((await dt({ operation: "subtract", value: "2024-03-31", unit: "months", amount: 1, format: f }))["date"]).toBe("2024-02-29");
    await expect(dt({ operation: "add", value: "2024-01-01", unit: "months", amount: 1.5 })).rejects.toThrow(/whole number/);
  });
  it("diff: целые единицы, отрицательные значения, календарные месяцы и годы", async () => {
    const d = (value: string, other: string, unit: string) => dt({ operation: "diff", value, other, unit }).then((r) => r["date"]);
    expect(await d("2024-01-01", "2024-01-11", "days")).toBe(10);
    expect(await d("2024-01-11", "2024-01-01", "days")).toBe(-10);
    expect(await d("2024-01-01T00:00:00Z", "2024-01-01T05:30:00Z", "hours")).toBe(5);
    expect(await d("2024-01-31", "2024-02-29", "months")).toBe(1); // согласовано с add: 31 янв + 1 мес = 29 фев
    expect(await d("2024-01-31", "2024-02-28", "months")).toBe(0);
    expect(await d("2024-01-15", "2024-03-15", "months")).toBe(2);
    expect(await d("2020-06-01", "2024-05-31", "years")).toBe(3);
    expect(await d("2024-03-15", "2024-01-15", "months")).toBe(-2);
    await expect(dt({ operation: "diff", value: "2024-01-01" })).rejects.toThrow(/other/);
  });
  it("extract", async () => {
    const x = (part: string) => dt({ operation: "extract", value: "2024-03-10T13:14:15Z", part }).then((r) => r["date"]); // воскресенье
    expect([await x("year"), await x("month"), await x("day"), await x("hour"), await x("minute"), await x("second")]).toEqual([2024, 3, 10, 13, 14, 15]);
    expect(await x("weekday")).toBe(7);
    expect(await x("week")).toBe(10);
    expect((await dt({ operation: "extract", value: "2021-01-03", part: "week" }))["date"]).toBe(53); // ISO-неделя прошлого года
  });
  it("round: down и up", async () => {
    const r = (value: string, unit: string, direction: string) => dt({ operation: "round", value, unit, direction }).then((x) => x["date"]);
    expect(await r("2024-03-10T13:14:15Z", "days", "down")).toBe("2024-03-10T00:00:00.000Z");
    expect(await r("2024-03-10T13:14:15Z", "days", "up")).toBe("2024-03-11T00:00:00.000Z");
    expect(await r("2024-03-10T00:00:00Z", "days", "up")).toBe("2024-03-10T00:00:00.000Z"); // уже на границе
    expect(await r("2024-03-10T13:14:15Z", "hours", "down")).toBe("2024-03-10T13:00:00.000Z");
    expect(await r("2024-03-13T10:00:00Z", "weeks", "down")).toBe("2024-03-11T00:00:00.000Z"); // понедельник
    expect(await r("2024-03-10T13:14:15Z", "months", "up")).toBe("2024-04-01T00:00:00.000Z");
    expect(await r("2024-03-10T13:14:15Z", "years", "down")).toBe("2024-01-01T00:00:00.000Z");
  });
  it("includeInput и своё имя поля", async () => {
    expect(await dt({ operation: "format", value: "{{ at }}", format: "YYYY", field: "year", includeInput: true }, { at: "2024-01-01", keep: 1 })).toEqual({ at: "2024-01-01", keep: 1, year: "2024" });
    expect(await dt({ operation: "format", value: "2024-01-01", format: "YYYY", field: "a.b" })).toEqual({ a: { b: "2024" } });
  });
  it("ошибки: кривая дата, операция, единица", async () => {
    await expect(dt({ operation: "format", value: "not a date" })).rejects.toThrow(/Invalid date/);
    await expect(dt({ operation: "format", value: "{{ x }}" }, { x: null })).rejects.toThrow(/Nothing to work with/);
    await expect(dt({ operation: "format", value: "{{ typo }}" }, { x: "2024-01-01" })).rejects.toThrow(/resolved to no value/);
    await expect(dt({ operation: "explode" })).rejects.toThrow(/Unknown operation/);
    await expect(dt({ operation: "add", value: "2024-01-01", unit: "decades" })).rejects.toThrow(/Unknown unit/);
  });
});

describe("Crypto", () => {
  const cr = (params: Record<string, Json>, input?: Json) => out0(Crypto, input, params) as Promise<Record<string, Json>>;
  it("hash совпадает с эталонами", async () => {
    expect((await cr({ action: "hash", value: "abc" }))["value"]).toBe(createHash("sha256").update("abc").digest("hex"));
    expect((await cr({ action: "hash", value: "abc" }))["value"]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect((await cr({ action: "hash", algorithm: "md5", value: "{{ x }}" }, { x: "" }))["value"]).toBe("d41d8cd98f00b204e9800998ecf8427e"); // пустая строка — это значение, а не «нет значения»
  });
  it("hash: кодировки, значение из входа, объекты как JSON", async () => {
    expect((await cr({ action: "hash", algorithm: "sha1", encoding: "base64" }, "abc"))["value"]).toBe(createHash("sha1").update("abc").digest("base64"));
    expect((await cr({ action: "hash", value: "{{ name }}" }, { name: "abc" }))["value"]).toBe(createHash("sha256").update("abc").digest("hex"));
    expect((await cr({ action: "hash" }, { a: 1 }))["value"]).toBe(createHash("sha256").update('{"a":1}').digest("hex"));
  });
  it("hmac совпадает с эталоном", async () => {
    expect((await cr({ action: "hmac", value: "The quick brown fox jumps over the lazy dog", secret: "key" }))["value"]).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
    expect((await cr({ action: "hmac", algorithm: "sha512", value: "x", secret: "k", encoding: "base64url" }))["value"]).toBe(createHmac("sha512", "k").update("x").digest("base64url"));
    await expect(cr({ action: "hmac", value: "x" })).rejects.toThrow(/secret/);
    await expect(cr({ action: "hash", value: "{{ nope }}" }, { a: 1 })).rejects.toThrow(/resolved to no value/);
  });
  it("generate: uuid и случайные байты", async () => {
    expect((await cr({ action: "generate" }))["value"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const hex = (await cr({ action: "generate", kind: "bytes", length: 10 }))["value"] as string;
    expect(hex).toMatch(/^[0-9a-f]{20}$/);
    expect((await cr({ action: "generate", kind: "bytes", length: 10 }))["value"]).not.toBe(hex);
    await expect(cr({ action: "generate", kind: "bytes", length: 0 })).rejects.toThrow(/between/);
    await expect(cr({ action: "generate", kind: "bytes", length: 5000 })).rejects.toThrow(/between/);
  });
  it("encrypt → decrypt возвращает исходный текст; соль и iv разные", async () => {
    const enc1 = (await cr({ action: "encrypt", value: "секрет 🔐", secret: "pw" }))["value"] as string;
    const enc2 = (await cr({ action: "encrypt", value: "секрет 🔐", secret: "pw" }))["value"] as string;
    expect(enc1).toMatch(/^v1\./);
    expect(enc1).not.toBe(enc2);
    expect((await cr({ action: "decrypt", value: enc1, secret: "pw" }))["value"]).toBe("секрет 🔐");
  });
  it("decrypt: чужой пароль, подмена, не зашифрованное, нет пароля", async () => {
    const enc = (await cr({ action: "encrypt", value: "data", secret: "pw" }))["value"] as string;
    await expect(cr({ action: "decrypt", value: enc, secret: "other" })).rejects.toThrow(/wrong passphrase/);
    const parts = enc.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    await expect(cr({ action: "decrypt", value: parts.join("."), secret: "pw" })).rejects.toThrow(/wrong passphrase/);
    await expect(cr({ action: "decrypt", value: "plain text", secret: "pw" })).rejects.toThrow(/not an encrypted/);
    await expect(cr({ action: "encrypt", value: "x" })).rejects.toThrow(/passphrase/);
    await expect(cr({ action: "decrypt", value: enc })).rejects.toThrow(/passphrase/);
  });
  it("includeInput, имя поля, неизвестные значения", async () => {
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

  it("sign даёт валидный HS256-токен (проверка независимой реализацией)", async () => {
    const { token } = (await jwt({ operation: "sign", secret, payload: { sub: "u1", name: "{{ name }}" } }, { name: "Ann" })) as { token: string };
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload).toMatchObject({ sub: "u1", name: "Ann", iat: expect.any(Number) });
    expect(s).toBe(createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url"));
  });
  it("sign: expiresInSeconds и другие алгоритмы", async () => {
    const { token } = (await jwt({ operation: "sign", secret, algorithm: "HS512", expiresInSeconds: 60 })) as { token: string };
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(payload.exp - payload.iat).toBe(60);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).alg).toBe("HS512");
    expect(await jwt({ operation: "verify", secret, algorithm: "HS512", token })).toMatchObject({ valid: true });
  });
  it("sign → verify; токен берётся из входа (строка или поле token)", async () => {
    const { token } = (await jwt({ operation: "sign", secret, payload: { a: 1 } })) as { token: string };
    expect(await jwt({ operation: "verify", secret }, token)).toMatchObject({ valid: true, payload: { a: 1 } });
    expect(await jwt({ operation: "verify", secret }, { token })).toMatchObject({ valid: true });
    expect(await jwt({ operation: "verify", secret, token: "{{ t }}" }, { t: token })).toMatchObject({ valid: true });
  });
  it("verify отклоняет: чужой секрет, подмену, другой алгоритм, alg none, истёкший и ещё не действующий", async () => {
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
  it("decode не проверяет подпись", async () => {
    expect(await jwt({ operation: "decode" }, forge({ alg: "HS256", typ: "JWT" }, { x: 1 }, "any"))).toEqual({
      header: { alg: "HS256", typ: "JWT" },
      payload: { x: 1 },
    });
  });
  it("мусорные токены и отсутствие секрета", async () => {
    for (const bad of ["abc", "a.b", "a.b.c.d", "!!!.???.***"]) await expect(jwt({ operation: "decode" }, bad), bad).rejects.toThrow(/malformed/);
    await expect(jwt({ operation: "sign" })).rejects.toThrow(/secret/);
    await expect(jwt({ operation: "verify" }, forge({ alg: "HS256" }, {}))).rejects.toThrow(/secret/);
    await expect(jwt({ operation: "sign", secret, payload: [1] })).rejects.toThrow(/payload/);
  });
});

describe("Wait", () => {
  it("ждёт заданное время и пропускает данные", async () => {
    const t = Date.now();
    expect(await out0(Wait, { a: 1 }, { amount: 0.08, unit: "seconds" })).toEqual({ a: 1 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(70);
  });
  it("ноль — сразу", async () => {
    expect(await out0(Wait, 5, { amount: 0 })).toBe(5);
  });
  it("прерывается отменой, в том числе до старта", async () => {
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
  it("лимит запуска и кривые значения", async () => {
    await expect(run(Wait, 1, { amount: 6, unit: "minutes" })).rejects.toThrow(/exceeds the run limit/);
    await expect(run(Wait, 1, { amount: -1 })).rejects.toThrow(/non-negative/);
    await expect(run(Wait, 1, { unit: "days" })).rejects.toThrow(/Unknown unit/);
  });
});

describe("Stop and Error", () => {
  it("бросает текст с подстановкой данных", async () => {
    await expect(run(StopAndError, { id: 7 }, { message: "Order {{ id }} rejected" })).rejects.toThrow("Order 7 rejected");
    await expect(run(StopAndError, 1)).rejects.toThrow("Workflow stopped");
  });
  it("тип object: сообщение — JSON объекта", async () => {
    await expect(run(StopAndError, { code: 42 }, { errorType: "object", errorObject: { code: "{{ code }}", fixed: "x" } })).rejects.toThrow('{"code":42,"fixed":"x"}');
  });
  it("конечный блок: без выходов", () => {
    expect(StopAndError.ports.outputs).toEqual([]);
  });
});

describe("Webhook / Respond to Webhook", () => {
  it("normalizeWebhookPath", () => {
    expect(normalizeWebhookPath("/orders/new/")).toBe("orders/new");
    expect(normalizeWebhookPath("a.b_c-d~e")).toBe("a.b_c-d~e");
    for (const bad of ["", "/", "a b", "a//b", "../x", "a?b", "a#b", "ä"]) expect(normalizeWebhookPath(bad), bad).toBeNull();
  });
  it("webhook(): путь и метод; кривой путь — ошибка", () => {
    expect(Webhook.webhook({ path: "/x/", method: "GET" })).toEqual({ path: "x", method: "GET" });
    expect(Webhook.webhook({ path: "x" })).toEqual({ path: "x", method: "POST" });
    expect(() => Webhook.webhook({ path: "a b" })).toThrow(/Invalid webhook path/);
  });
  it("run отдаёт данные запроса, а при ручном запуске — пример", async () => {
    const payload = { method: "POST", path: "x", query: { a: "1" }, headers: {}, body: { ok: true } };
    expect(await out0(Webhook, undefined, { path: "x" }, { triggerData: payload })).toEqual(payload);
    expect(await out0(Webhook, undefined, { path: "x", method: "GET" })).toMatchObject({ method: "GET", path: "x", query: {}, body: null });
    expect(await out0(Webhook, undefined, { path: "x", method: "ANY" })).toMatchObject({ method: "POST" });
  });
  it("триггер-свойства", () => {
    expect([Webhook.isTrigger, Webhook.autoTrigger, Webhook.ports.inputs.length]).toEqual([true, true, 0]);
  });
  it("respond: по умолчанию тело — вход; параметры, шаблоны, заголовки строками", async () => {
    expect(await run(RespondToWebhook, { a: 1 })).toEqual({ response: { status: 200, headers: {}, body: { a: 1 } } });
    expect(await run(RespondToWebhook, { id: 5 }, { status: 201, body: { created: "{{ id }}" }, headers: { "X-N": 5 } })).toEqual({
      response: { status: 201, headers: { "X-N": "5" }, body: { created: 5 } },
    });
    await expect(run(RespondToWebhook, 1, { headers: [1] })).rejects.toThrow(/headers/);
    expect(RespondToWebhook.ports.outputs).toEqual([]);
  });
});

describe("cloneJson", () => {
  it("глубокая копия", () => {
    const a = { x: [1, { y: 2 }] };
    const b = cloneJson(a);
    (b.x[1] as { y: number }).y = 9;
    expect(a).toEqual({ x: [1, { y: 2 }] });
  });
});

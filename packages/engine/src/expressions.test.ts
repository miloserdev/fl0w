import { describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { validateFlow } from "./validate";

/** Source(s) → блок → Result; выражения `{{ inputs.… }}` подставляет движок в параметры ЛЮБОГО блока. */
const run = (source: Json, block: ReturnType<typeof node>, source2?: Json) => {
  const nodes = [node("s", "source", { json: source }), block, node("res", "result")];
  const edges = [edge("s", block.id), edge(block.id, "res")];
  if (source2 !== undefined) {
    nodes.push(node("s2", "source", { json: source2 }));
    edges.push(edge("s2", block.id, "out0", "in1"));
  }
  return collect(flow(nodes, edges));
};
const echo = (params: Record<string, Json>) => node("b", "echo", params);
const result = async (...a: Parameters<typeof run>) => (await run(...a)).done?.result;

describe("выражения {{ inputs… }} в параметрах любых блоков", () => {
  it("число, булево и enum берутся из входа с сохранением типа", async () => {
    expect(
      await result({ n: 5, flag: true, mode: "y" }, echo({ n: "{{ inputs.in0.n }}", flag: "{{ inputs.in0.flag }}", mode: "{{ inputs.in0.mode }}" })),
    ).toMatchObject({ n: 5, flag: true, mode: "y" });
  });

  it("строка из одного выражения сохраняет тип (объект, массив), внутри текста — приводится к строке", async () => {
    const src = { user: { name: "Ann", tags: ["a", "b"] }, id: 7 };
    expect(await result(src, echo({ list: "{{ inputs.in0.user }}", a: "id-{{ inputs.in0.id }}/{{ inputs.in0.user.tags }}/{{ inputs.in0.user.name }}" }))).toMatchObject({
      list: { name: "Ann", tags: ["a", "b"] },
      a: 'id-7/["a","b"]/Ann',
    });
    expect(await result(src, echo({ list: "{{ inputs }}" }))).toMatchObject({ list: { in0: src } });
  });

  it("глубоко внутри json-параметра: объекты, массивы, вложенные строки", async () => {
    expect(
      await result({ x: 1, y: "два" }, echo({ list: { a: ["{{ inputs.in0.x }}", { b: "{{ inputs.in0.y }}" }], c: 5, d: "без выражений" } })),
    ).toMatchObject({ list: { a: [1, { b: "два" }], c: 5, d: "без выражений" } });
  });

  it("несколько входов: данные любого порта через inputs.in1", async () => {
    expect(await result({ a: "левый" }, echo({ a: "{{ inputs.in0.a }} + {{ inputs.in1.b }}", n: "{{ inputs.in1.count }}" }), { b: "правый", count: 3 })).toMatchObject({
      a: "левый + правый",
      n: 3,
    });
  });

  it("индексы массивов и вложенные пути", async () => {
    expect(await result({ rows: [{ v: 10 }, { v: 20 }] }, echo({ n: "{{ inputs.in0.rows.1.v }}" }))).toMatchObject({ n: 20 });
  });

  it("нет значения: целое выражение → null, в тексте → пустая строка (параметр не рушится, пока он необязателен)", async () => {
    expect(await result({}, echo({ list: "{{ inputs.in0.nope }}", a: "[{{ inputs.in0.nope }}]" }))).toMatchObject({ list: null, a: "[]" });
  });

  it("относительные шаблоны {{ поле }} остаются блокам — движок их не трогает", async () => {
    expect(await result({ name: "Ann" }, echo({ a: "{{ name }} / {{ inputs.in0.name }}" }))).toMatchObject({ a: "{{ name }} / Ann" });
  });

  it("параметры с expressions: false не подставляются (код, скрипты)", async () => {
    expect(await result({ x: 1 }, echo({ raw: "return `${{ inputs.in0.x }}`; {{ inputs.in0.x }}" }))).toMatchObject({ raw: "return `${{ inputs.in0.x }}`; {{ inputs.in0.x }}" });
  });

  it("настоящие блоки: Limit.count, Filter.value, Crypto.value, Wait.amount", async () => {
    expect(await result({ items: [1, 2, 3, 4, 5], n: 2 }, node("b", "limit", { path: "items", count: "{{ inputs.in0.n }}" }))).toEqual([1, 2]);
    expect(
      await result({ rows: [{ v: 1 }, { v: 5 }, { v: 9 }], min: 3 }, node("b", "filter", { path: "rows", field: "v", operator: "gt", value: "{{ inputs.in0.min }}" })),
    ).toEqual([{ v: 5 }, { v: 9 }]);
    const { createHash } = await import("node:crypto");
    expect(await result({ id: 7 }, node("b", "crypto", { action: "hash", value: "id-{{ inputs.in0.id }}" }))).toEqual({
      value: createHash("sha256").update("id-7").digest("hex"),
    });
    const t = Date.now();
    await result({ secs: 0.05 }, node("b", "wait", { amount: "{{ inputs.in0.secs }}", unit: "seconds" }));
    expect(Date.now() - t).toBeGreaterThanOrEqual(40);
  });

  describe("проверка после подстановки", () => {
    const error = async (source: Json, params: Record<string, Json>) => {
      const { events, done } = await run(source, echo(params));
      const e = events.find((x) => x.event === "node:error");
      return { nodeError: e?.event === "node:error" ? e.error : undefined, flowError: done?.error };
    };

    it("число из выражения должно быть числом и в диапазоне", async () => {
      expect((await error({ n: "abc" }, { n: "{{ inputs.in0.n }}" })).nodeError).toBe('Invalid parameters after resolving expressions: Parameter "n" must be a number');
      expect((await error({ n: -3 }, { n: "{{ inputs.in0.n }}" })).nodeError).toMatch(/must be >= 0/);
      expect((await error({}, { n: "{{ inputs.in0.missing }}" })).nodeError).toBeUndefined(); // нет значения у необязательного — не ошибка
    });

    it("enum и boolean из выражения проверяются", async () => {
      expect((await error({ mode: "z" }, { mode: "{{ inputs.in0.mode }}" })).nodeError).toMatch(/must be one of: x, y/);
      expect((await error({ flag: "yes" }, { flag: "{{ inputs.in0.flag }}" })).nodeError).toMatch(/must be a boolean/);
    });

    it("обязательный параметр, чьё выражение ничего не дало, — понятная ошибка", async () => {
      const r = await error({}, { need: "{{ inputs.in0.nope }}" });
      expect(r.nodeError).toMatch(/Parameter "need" is required/);
      expect(r.flowError).toMatch(/failed: Invalid parameters after resolving expressions/);
    });
  });

  describe("проверка флоу до запуска", () => {
    const codes = (params: Record<string, Json>) => {
      const r = validateFlow(flow([node("s", "source", { json: 1 }), node("b", "echo", params), node("res", "result")], [edge("s", "b"), edge("b", "res")]), testRegistry);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    it("выражение в числовом/булевом/enum параметре проходит, обычное неверное значение — нет", () => {
      expect(codes({ n: "{{ inputs.in0.x }}", flag: "{{ inputs.in0.f }}", mode: "{{ inputs.in0.m }}" })).toEqual([]);
      expect(codes({ n: "abc" })).toEqual(["param_type"]);
      expect(codes({ mode: "z" })).toEqual(["param_enum"]);
      expect(codes({ n: -1 })).toEqual(["param_range"]);
      expect(codes({ need: "" })).toEqual(["param_required"]);
    });
  });
});

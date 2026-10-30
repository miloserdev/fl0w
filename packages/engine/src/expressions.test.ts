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

  it("нет значения: явный null во входе → null, в тексте → пустая строка (целое выражение с неверным путём — ошибка)", async () => {
    expect(await result({ z: null }, echo({ list: "{{ inputs.in0.z }}", a: "[{{ inputs.in0.nope }}]" }))).toMatchObject({ list: null, a: "[]" });
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
      expect((await error({ x: 1 }, { n: "{{ inputs.in0.missing }}" })).flowError).toMatch(/Parameter "n".*resolved to no value/);
    });

    it("enum и boolean из выражения проверяются", async () => {
      expect((await error({ mode: "z" }, { mode: "{{ inputs.in0.mode }}" })).nodeError).toMatch(/must be one of: x, y/);
      expect((await error({ flag: "yes" }, { flag: "{{ inputs.in0.flag }}" })).nodeError).toMatch(/must be a boolean/);
    });

    it("обязательный параметр, чьё выражение ничего не дало, — понятная ошибка", async () => {
      const r = await error({ x: 1 }, { need: "{{ inputs.in0.nope }}" });
      expect(r.nodeError).toMatch(/Parameter "need".*resolved to no value/);
      expect(r.flowError).toMatch(/failed: Parameter "need"/);
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

describe("node:start несёт данные ноды для отладки", () => {
  const start = async (...a: Parameters<typeof run>) => {
    const r = await run(...a);
    return r.events.find((e) => e.event === "node:start" && e.nodeId === "b") as Extract<(typeof r.events)[number], { event: "node:start" }>;
  };

  it("вход и параметры после подстановки выражений", async () => {
    const e = await start({ n: 5 }, echo({ n: "{{ inputs.in0.n }}", a: "text" }));
    expect(e.input).toEqual({ in0: { n: 5 } });
    expect(e.params).toMatchObject({ n: 5, a: "text" });
  });

  it("у источника вход пуст", async () => {
    const r = await run({ x: 1 }, echo({}));
    const e = r.events.find((x) => x.event === "node:start" && x.nodeId === "s");
    expect(e).toMatchObject({ input: {} });
  });

  it("большое значение усекается, а не раздувает событие", async () => {
    const e = await start({ big: "x".repeat(200_000) }, echo({}));
    const text = JSON.stringify(e.input);
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("truncated");
  });

  it("ошибка подстановки выражения по-прежнему падает на ноде, а не на старте события", async () => {
    const r = await run({ n: "abc" }, echo({ n: "{{ inputs.in0.n }}" }));
    expect(r.done?.error).toMatch(/Invalid parameters/);
    expect(r.events.some((e) => e.event === "node:error" && e.nodeId === "b")).toBe(true);
  });
});

describe("node:start скрывает секреты в параметрах", () => {
  it("токены и пароли маскируются (в том числе во вложенных объектах), ссылки env: остаются", async () => {
    const r = await run({ x: 1 }, echo({ list: { Authorization: "Bearer abc", nested: [{ password: "p" }], plain: "ok" }, a: "x" }));
    const e = r.events.find((x) => x.event === "node:start" && x.nodeId === "b") as { params: Record<string, Json> };
    expect(JSON.stringify(e.params)).not.toMatch(/Bearer abc|"p"/);
    expect(e.params["list"]).toEqual({ Authorization: "***", nested: [{ password: "***" }], plain: "ok" });
    const ref = await run({ x: 1 }, echo({ list: { token: "env:FL0W_SECRET_X" } }));
    const e2 = ref.events.find((x) => x.event === "node:start" && x.nodeId === "b") as { params: Record<string, Json> };
    expect(e2.params["list"]).toEqual({ token: "env:FL0W_SECRET_X" });
  });
});

describe("выражение в строковом параметре", () => {
  it("число из входа (например id чата) приводится к строке, а не ломает проверку типа", async () => {
    const r = await run({ chat: { id: 123, ok: true } }, echo({ a: "{{ inputs.in0.chat.id }}", need: "{{ inputs.in0.chat.ok }}" }));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toMatchObject({ a: "123", need: "true" });
  });

  it("объект в строковом параметре — JSON-текстом", async () => {
    const r = await run({ chat: { id: 1 } }, echo({ a: "{{ inputs.in0.chat }}" }));
    expect(r.done?.result).toMatchObject({ a: '{"id":1}' });
  });
});

describe("ревью потоков: диагностика и маскирование", () => {
  it("целое выражение с несуществующим путём — понятная ошибка, а не тихий null/значение по умолчанию", async () => {
    const r = await run({ n: 1 }, echo({ n: "{{ inputs.in0.nope }}" }));
    expect(r.done?.error).toMatch(/Parameter "n".*resolved to no value/);
    const t = await run({ n: 1 }, echo({ a: "{{ inputs.in0.nope }}" }));
    expect(t.done?.error).toMatch(/Parameter "a".*resolved to no value/);
  });

  it("явный null во входе — не ошибка, выражение внутри текста с пропущенным полем даёт пустую строку", async () => {
    const r = await run({ a: null }, echo({ list: "{{ inputs.in0.a }}", a: "x{{ inputs.in0.nope }}y" }));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toMatchObject({ a: "xy" });
  });

  it("заголовки с учётными данными во входе и выходе ноды маскируются в событиях, а данные дальше идут как есть", async () => {
    const r = await run({ headers: { authorization: "Bearer abc", accept: "x" } }, echo({ list: "{{ inputs.in0.headers }}" }));
    const text = JSON.stringify(r.events.filter((e) => e.event === "node:start" || e.event === "node:done"));
    expect(text).not.toContain("Bearer abc");
    expect(text).toContain("***");
    expect(JSON.stringify(r.done?.result)).toContain("Bearer abc");
  });
});

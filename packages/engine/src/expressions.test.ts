import { describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { validateFlow } from "./validate";

/** Source(s) → block → Result; the engine substitutes `{{ inputs.… }}` expressions into the parameters of ANY block. */
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

describe("{{ inputs… }} expressions in parameters of any block", () => {
  it("number, boolean and enum are taken from the input keeping their type", async () => {
    expect(
      await result({ n: 5, flag: true, mode: "y" }, echo({ n: "{{ inputs.in0.n }}", flag: "{{ inputs.in0.flag }}", mode: "{{ inputs.in0.mode }}" })),
    ).toMatchObject({ n: 5, flag: true, mode: "y" });
  });

  it("a string consisting of one expression keeps its type (object, array); inside text it is converted to a string", async () => {
    const src = { user: { name: "Ann", tags: ["a", "b"] }, id: 7 };
    expect(await result(src, echo({ list: "{{ inputs.in0.user }}", a: "id-{{ inputs.in0.id }}/{{ inputs.in0.user.tags }}/{{ inputs.in0.user.name }}" }))).toMatchObject({
      list: { name: "Ann", tags: ["a", "b"] },
      a: 'id-7/["a","b"]/Ann',
    });
    expect(await result(src, echo({ list: "{{ inputs }}" }))).toMatchObject({ list: { in0: src } });
  });

  it("deep inside a json parameter: objects, arrays, nested strings", async () => {
    expect(
      await result({ x: 1, y: "два" }, echo({ list: { a: ["{{ inputs.in0.x }}", { b: "{{ inputs.in0.y }}" }], c: 5, d: "без выражений" } })),
    ).toMatchObject({ list: { a: [1, { b: "два" }], c: 5, d: "без выражений" } });
  });

  it("several inputs: data of any port via inputs.in1", async () => {
    expect(await result({ a: "левый" }, echo({ a: "{{ inputs.in0.a }} + {{ inputs.in1.b }}", n: "{{ inputs.in1.count }}" }), { b: "правый", count: 3 })).toMatchObject({
      a: "левый + правый",
      n: 3,
    });
  });

  it("array indexes and nested paths", async () => {
    expect(await result({ rows: [{ v: 10 }, { v: 20 }] }, echo({ n: "{{ inputs.in0.rows.1.v }}" }))).toMatchObject({ n: 20 });
  });

  it("no value: explicit null in the input → null, inside text → empty string (a whole expression with a wrong path is an error)", async () => {
    expect(await result({ z: null }, echo({ list: "{{ inputs.in0.z }}", a: "[{{ inputs.in0.nope }}]" }))).toMatchObject({ list: null, a: "[]" });
  });

  it("relative templates {{ field }} are left to the blocks; the engine does not touch them", async () => {
    expect(await result({ name: "Ann" }, echo({ a: "{{ name }} / {{ inputs.in0.name }}" }))).toMatchObject({ a: "{{ name }} / Ann" });
  });

  it("parameters with expressions: false are not substituted (code, scripts)", async () => {
    expect(await result({ x: 1 }, echo({ raw: "return `${{ inputs.in0.x }}`; {{ inputs.in0.x }}" }))).toMatchObject({ raw: "return `${{ inputs.in0.x }}`; {{ inputs.in0.x }}" });
  });

  it("real blocks: Limit.count, Filter.value, Crypto.value, Wait.amount", async () => {
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

  describe("checking after substitution", () => {
    const error = async (source: Json, params: Record<string, Json>) => {
      const { events, done } = await run(source, echo(params));
      const e = events.find((x) => x.event === "node:error");
      return { nodeError: e?.event === "node:error" ? e.error : undefined, flowError: done?.error };
    };

    it("a number from an expression must be a number and within range", async () => {
      expect((await error({ n: "abc" }, { n: "{{ inputs.in0.n }}" })).nodeError).toBe('Invalid parameters after resolving expressions: Parameter "n" must be a number');
      expect((await error({ n: -3 }, { n: "{{ inputs.in0.n }}" })).nodeError).toMatch(/must be >= 0/);
      expect((await error({ x: 1 }, { n: "{{ inputs.in0.missing }}" })).flowError).toMatch(/Parameter "n".*resolved to no value/);
    });

    it("enum and boolean from an expression are checked", async () => {
      expect((await error({ mode: "z" }, { mode: "{{ inputs.in0.mode }}" })).nodeError).toMatch(/must be one of: x, y/);
      expect((await error({ flag: "yes" }, { flag: "{{ inputs.in0.flag }}" })).nodeError).toMatch(/must be a boolean/);
    });

    it("a required parameter whose expression produced nothing is a clear error", async () => {
      const r = await error({ x: 1 }, { need: "{{ inputs.in0.nope }}" });
      expect(r.nodeError).toMatch(/Parameter "need".*resolved to no value/);
      expect(r.flowError).toMatch(/failed: Parameter "need"/);
    });
  });

  describe("flow validation before the run", () => {
    const codes = (params: Record<string, Json>) => {
      const r = validateFlow(flow([node("s", "source", { json: 1 }), node("b", "echo", params), node("res", "result")], [edge("s", "b"), edge("b", "res")]), testRegistry);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    it("an expression in a number/boolean/enum parameter passes, an ordinary wrong value does not", () => {
      expect(codes({ n: "{{ inputs.in0.x }}", flag: "{{ inputs.in0.f }}", mode: "{{ inputs.in0.m }}" })).toEqual([]);
      expect(codes({ n: "abc" })).toEqual(["param_type"]);
      expect(codes({ mode: "z" })).toEqual(["param_enum"]);
      expect(codes({ n: -1 })).toEqual(["param_range"]);
      expect(codes({ need: "" })).toEqual(["param_required"]);
    });
  });
});

describe("node:start carries node data for debugging", () => {
  const start = async (...a: Parameters<typeof run>) => {
    const r = await run(...a);
    return r.events.find((e) => e.event === "node:start" && e.nodeId === "b") as Extract<(typeof r.events)[number], { event: "node:start" }>;
  };

  it("input and parameters after expression substitution", async () => {
    const e = await start({ n: 5 }, echo({ n: "{{ inputs.in0.n }}", a: "text" }));
    expect(e.input).toEqual({ in0: { n: 5 } });
    expect(e.params).toMatchObject({ n: 5, a: "text" });
  });

  it("a source has an empty input", async () => {
    const r = await run({ x: 1 }, echo({}));
    const e = r.events.find((x) => x.event === "node:start" && x.nodeId === "s");
    expect(e).toMatchObject({ input: {} });
  });

  it("a large value is truncated rather than bloating the event", async () => {
    const e = await start({ big: "x".repeat(200_000) }, echo({}));
    const text = JSON.stringify(e.input);
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("truncated");
  });

  it("an expression substitution error still fails on the node, not on the event start", async () => {
    const r = await run({ n: "abc" }, echo({ n: "{{ inputs.in0.n }}" }));
    expect(r.done?.error).toMatch(/Invalid parameters/);
    expect(r.events.some((e) => e.event === "node:error" && e.nodeId === "b")).toBe(true);
  });
});

describe("node:start hides secrets in parameters", () => {
  it("tokens and passwords are masked (including in nested objects), env: references stay", async () => {
    const r = await run({ x: 1 }, echo({ list: { Authorization: "Bearer abc", nested: [{ password: "p" }], plain: "ok" }, a: "x" }));
    const e = r.events.find((x) => x.event === "node:start" && x.nodeId === "b") as { params: Record<string, Json> };
    expect(JSON.stringify(e.params)).not.toMatch(/Bearer abc|"p"/);
    expect(e.params["list"]).toEqual({ Authorization: "***", nested: [{ password: "***" }], plain: "ok" });
    const ref = await run({ x: 1 }, echo({ list: { token: "env:FL0W_SECRET_X" } }));
    const e2 = ref.events.find((x) => x.event === "node:start" && x.nodeId === "b") as { params: Record<string, Json> };
    expect(e2.params["list"]).toEqual({ token: "env:FL0W_SECRET_X" });
  });
});

describe("expression in a string parameter", () => {
  it("a number from the input (e.g. a chat id) is converted to a string rather than breaking the type check", async () => {
    const r = await run({ chat: { id: 123, ok: true } }, echo({ a: "{{ inputs.in0.chat.id }}", need: "{{ inputs.in0.chat.ok }}" }));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toMatchObject({ a: "123", need: "true" });
  });

  it("an object in a string parameter becomes JSON text", async () => {
    const r = await run({ chat: { id: 1 } }, echo({ a: "{{ inputs.in0.chat }}" }));
    expect(r.done?.result).toMatchObject({ a: '{"id":1}' });
  });
});

describe("flow review: diagnostics and masking", () => {
  it("a whole expression with a nonexistent path is a clear error, not a silent null/default value", async () => {
    const r = await run({ n: 1 }, echo({ n: "{{ inputs.in0.nope }}" }));
    expect(r.done?.error).toMatch(/Parameter "n".*resolved to no value/);
    const t = await run({ n: 1 }, echo({ a: "{{ inputs.in0.nope }}" }));
    expect(t.done?.error).toMatch(/Parameter "a".*resolved to no value/);
  });

  it("explicit null in the input is not an error; an expression inside text with a missing field gives an empty string", async () => {
    const r = await run({ a: null }, echo({ list: "{{ inputs.in0.a }}", a: "x{{ inputs.in0.nope }}y" }));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toMatchObject({ a: "xy" });
  });

  it("headers with credentials in a node's input and output are masked in events, while the data goes on as is", async () => {
    const r = await run({ headers: { authorization: "Bearer abc", accept: "x" } }, echo({ list: "{{ inputs.in0.headers }}" }));
    const text = JSON.stringify(r.events.filter((e) => e.event === "node:start" || e.event === "node:done"));
    expect(text).not.toContain("Bearer abc");
    expect(text).toContain("***");
    expect(JSON.stringify(r.done?.result)).toContain("Bearer abc");
  });
});

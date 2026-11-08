import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import type { Block, RunContext } from "./block";
import { Branch } from "./branch";
import { Every } from "./every";
import { Merge } from "./merge";
import { evalCondition } from "./conditions";
import { HttpRequest } from "./http-request";
import { deepEqual, getPath } from "./json-path";
import { registry } from "./registry";
import { Source } from "./source";
import { Transform } from "./transform";
import { isParamVisible, resolveParams, validateParams } from "./params";

const ctx = (signal = new AbortController().signal): RunContext => ({ log() {}, signal });
/** Call through the base type: subclasses' `run` may take fewer arguments than Block's. */
const call = (b: Block, inputs: Record<string, Json>, params: Record<string, Json>, c = ctx()) =>
  b.run(inputs, params, c);
const withDefaults = (cls: typeof Transform | typeof Branch | typeof HttpRequest | typeof Merge, p: Record<string, Json>) =>
  resolveParams(cls.params, p);

describe("getPath / deepEqual", () => {
  const v = { a: { b: [10, { c: 1 }] }, "": 5 };
  it("paths", () => {
    expect(getPath(v, "a.b.0")).toBe(10);
    expect(getPath(v, "a.b.1.c")).toBe(1);
    expect(getPath(v, "")).toBe(v);
    expect(getPath(v, ".")).toBe(v);
    expect(getPath(v, "a.zzz")).toBeUndefined();
    expect(getPath(v, "a.b.x")).toBeUndefined();
    expect(getPath(5, "a")).toBeUndefined();
  });
  it("does not read the prototype", () => {
    expect(getPath({}, "constructor")).toBeUndefined();
    expect(getPath({}, "__proto__")).toBeUndefined();
  });
  it("deepEqual", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe("evalCondition", () => {
  it.each([
    ["eq", { a: 1 }, { a: 1 }, true],
    ["eq", 1, "1", false],
    ["neq", 1, 2, true],
    ["gt", 3, 2, true],
    ["gt", 2, 2, false],
    ["gte", 2, 2, true],
    ["lt", "a", "b", true],
    ["lte", 2, 2, true],
    ["gt", "3", 2, false], // different types are not compared
    ["lt", null, 1, false],
    ["contains", "hello", "ell", true],
    ["contains", [1, { a: 1 }], { a: 1 }, true],
    ["contains", 5, 5, false],
    ["exists", 0, null, true],
    ["exists", null, null, false],
    ["exists", undefined, null, false],
    ["truthy", 0, null, false],
    ["truthy", "x", null, true],
  ] as [string, Json | undefined, Json, boolean][])("%s(%j, %j) = %s", (op, a, b, expected) => {
    expect(evalCondition(a, op, b)).toBe(expected);
  });
  it("unknown operator", () => {
    expect(() => evalCondition(1, "regex", 1)).toThrow(/Unknown operator/);
  });
});

describe("Source / Branch", () => {
  it("Source returns the given JSON", async () => {
    expect(await call(new Source(), {}, { json: { a: 1 } })).toEqual({ out0: { a: 1 } });
  });

  const branch = (p: Record<string, Json>, v: Json) =>
    call(new Branch(), { in0: v }, withDefaults(Branch, p));

  it("true -> out0, false -> out1; the other port has no key", async () => {
    expect(await branch({ field: "n", operator: "gt", value: 5 }, { n: 9 })).toEqual({ out0: { n: 9 } });
    expect(await branch({ field: "n", operator: "gt", value: 5 }, { n: 1 })).toEqual({ out1: { n: 1 } });
  });
  it("by default, truthy of the whole input", async () => {
    expect(await branch({}, "x")).toEqual({ out0: "x" });
    expect(await branch({}, 0)).toEqual({ out1: 0 });
  });
});

describe("Transform", () => {
  const items: Json[] = [
    { id: 1, name: "a", tags: ["x"], meta: { score: 5 } },
    { id: 2, name: "b", tags: [], meta: { score: 9 } },
    { id: 3, name: "c", tags: ["x", "y"], meta: {} },
  ];
  const tr = (p: Record<string, Json>, v: Json = items) =>
    call(new Transform(), { in0: v }, withDefaults(Transform, p));

  it("map without fields: elements as is", async () => {
    expect(await tr({ mode: "map" })).toEqual({ out0: items });
  });
  it("map: fields builds objects by paths", async () => {
    const out = await tr({ mode: "map", fields: { id: "id", score: "meta.score", self: "." } });
    expect((out["out0"] as Json[])[0]).toEqual({ id: 1, score: 5, self: items[0] });
    expect((out["out0"] as { score: Json }[])[2]!.score).toBeNull(); // no path -> null
  });
  it("path points to an array inside the input", async () => {
    const out = await tr({ mode: "map", path: "data.rows", fields: { n: "id" } }, { data: { rows: items } });
    expect(out["out0"]).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
  it("filter by a condition", async () => {
    expect(await tr({ mode: "filter", field: "meta.score", operator: "gt", value: 6 })).toEqual({ out0: [items[1]] });
    expect(await tr({ mode: "filter", field: "tags", operator: "contains", value: "x" })).toEqual({
      out0: [items[0], items[2]],
    });
    expect(await tr({ mode: "filter", field: "meta.score", operator: "exists" })).toEqual({
      out0: [items[0], items[1]],
    });
  });
  it("not an array -> a clear error", async () => {
    await expect(tr({ mode: "map" }, { a: 1 })).rejects.toThrow('Value at "." is not an array');
    await expect(tr({ mode: "map", path: "a" }, { a: 1 })).rejects.toThrow('Value at "a" is not an array');
  });
  it("broken fields -> an error", async () => {
    await expect(tr({ mode: "map", fields: [1] })).rejects.toThrow(/fields/);
    await expect(tr({ mode: "map", fields: { a: 1 } })).rejects.toThrow(/path string/);
  });
});

describe("Merge", () => {
  const merge = (mode: string, inputs: Record<string, Json>) =>
    call(new Merge(), inputs, resolveParams(Merge.params, { mode }));

  it("array: values in port order", async () => {
    expect(await merge("array", { in2: "c", in0: "a", in10: "z", in1: "b" })).toEqual({ out0: ["a", "b", "c", "z"] });
  });
  it("object: by port ids", async () => {
    expect(await merge("object", { in1: 2, in0: 1 })).toEqual({ out0: { in0: 1, in1: 2 } });
  });
  it("assign: a later input overrides an earlier one", async () => {
    expect(await merge("assign", { in1: { a: 2, c: 3 }, in0: { a: 1, b: 1 } })).toEqual({ out0: { a: 2, b: 1, c: 3 } });
  });
  it("concat: joins arrays", async () => {
    expect(await merge("concat", { in0: [1], in1: [2, 3] })).toEqual({ out0: [1, 2, 3] });
  });
  it("assign/concat with an unsuitable type: a clear error", async () => {
    await expect(merge("assign", { in0: { a: 1 }, in1: [1] })).rejects.toThrow('Input "in1" is not an object');
    await expect(merge("assign", { in0: null })).rejects.toThrow('Input "in0" is not an object');
    await expect(merge("concat", { in0: [1], in1: { a: 1 } })).rejects.toThrow('Input "in1" is not an array');
  });
  it("with no connected inputs: an empty result of the mode", async () => {
    expect(await merge("array", {})).toEqual({ out0: [] });
    expect(await merge("object", {})).toEqual({ out0: {} });
  });
  it("does not mutate input data", async () => {
    const a = { x: 1 };
    await merge("assign", { in0: a, in1: { y: 2 } });
    expect(a).toEqual({ x: 1 });
  });
});

describe("Every (trigger)", () => {
  it("period in ms by units", () => {
    expect(Every.intervalMs({ interval: 5, unit: "seconds" })).toBe(5000);
    expect(Every.intervalMs({ interval: 2, unit: "minutes" })).toBe(120_000);
    expect(Every.intervalMs({ interval: 1.5, unit: "hours" })).toBe(5_400_000);
    expect(Every.intervalMs({})).toBe(60_000); // defaults: 1 minute
  });
  it("broken values -> an error", () => {
    expect(() => Every.intervalMs({ interval: 1, unit: "weeks" })).toThrow(/Unknown unit/);
    expect(() => Every.intervalMs({ interval: 0, unit: "seconds" })).toThrow(/positive/);
    expect(() => Every.intervalMs({ interval: -3, unit: "seconds" })).toThrow(/positive/);
  });
  it("min/max of interval are checked as parameters", () => {
    expect(validateParams(Every.params, { interval: 0 }).map((i) => i.code)).toEqual(["range"]);
    expect(validateParams(Every.params, { interval: 100_001 }).map((i) => i.code)).toEqual(["range"]);
    expect(validateParams(Every.params, { interval: 1, unit: "minutes" })).toEqual([]);
    expect(validateParams(Every.params, {})).toEqual([]);
  });
  it("no inputs; only Every is a trigger", () => {
    expect(Every.ports.inputs).toEqual([]);
    expect(Object.values(registry).filter((c) => c.isTrigger).map((c) => c.type).sort()).toEqual([
      "activation_trigger", "call_trigger", "error_trigger", "every", "local_file_trigger", "mail_trigger", "manual", "telegram_trigger", "webhook", "workflow_trigger",
    ]);
    expect(Object.values(registry).filter((c) => c.autoTrigger).map((c) => c.type).sort()).toEqual([
      "activation_trigger", "call_trigger", "error_trigger", "every", "local_file_trigger", "mail_trigger", "telegram_trigger", "webhook", "workflow_trigger",
    ]);
    // they wait for an external event: a manual run does not start them (Every and Manual start)
    expect(Object.values(registry).filter((c) => c.eventDriven).map((c) => c.type).sort()).toEqual([
      "activation_trigger", "call_trigger", "error_trigger", "local_file_trigger", "mail_trigger", "telegram_trigger", "webhook", "workflow_trigger",
    ]);
    expect(Object.values(registry).filter((c) => c.type !== "every").every((c) => c.intervalMs({}) === null)).toBe(true);
  });
  it("run returns a timestamp", async () => {
    const out = await call(new Every(), {}, {});
    expect(new Date((out["out0"] as { triggeredAt: string }).triggeredAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("HttpRequest", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const echo = { method: req.method, url: req.url, body, ct: req.headers["content-type"] ?? null, x: req.headers["x-k"] ?? null };
        if (req.url === "/json") res.writeHead(200).end(JSON.stringify(echo));
        else if (req.url === "/empty") res.writeHead(204).end();
        else if (req.url === "/text") res.writeHead(200).end("<html>");
        else if (req.url === "/500") res.writeHead(500, "Boom").end("server exploded");
        else if (req.url === "/hang") return;
        else res.writeHead(404).end("nope");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const http = (p: Record<string, Json>, inputs: Record<string, Json> = {}, c = ctx()) =>
    new HttpRequest().run(inputs, withDefaults(HttpRequest, p), c);

  it("GET → JSON", async () => {
    const out = await http({ url: `${base}/json`, headers: { "X-K": "v" } });
    expect(out["out0"]).toMatchObject({ method: "GET", url: "/json", x: "v", body: "" });
  });
  it("POST: body from params", async () => {
    const out = await http({ method: "POST", url: `${base}/json`, body: { a: 1 } });
    expect(out["out0"]).toMatchObject({ method: "POST", body: '{"a":1}', ct: "application/json" });
  });
  it("POST: without body takes the in0 input", async () => {
    const out = await http({ method: "POST", url: `${base}/json` }, { in0: { from: "input" } });
    expect(out["out0"]).toMatchObject({ body: '{"from":"input"}' });
  });
  it("GET ignores the body", async () => {
    const out = await http({ url: `${base}/json`, body: { a: 1 } });
    expect(out["out0"]).toMatchObject({ method: "GET", body: "" });
  });
  it("an empty response -> null", async () => {
    expect(await http({ url: `${base}/empty` })).toEqual({ out0: null });
  });
  it("non-2xx -> an error with the status and the start of the body", async () => {
    await expect(http({ url: `${base}/500` })).rejects.toThrow("HTTP 500 Boom: server exploded");
    await expect(http({ url: `${base}/404x` })).rejects.toThrow(/HTTP 404/);
  });
  it("not JSON -> an error", async () => {
    await expect(http({ url: `${base}/text` })).rejects.toThrow("Response is not valid JSON");
  });
  it("only http(s) and a valid URL", async () => {
    await expect(http({ url: "file:///etc/passwd" })).rejects.toThrow(/Unsupported protocol/);
    await expect(http({ url: "not a url" })).rejects.toThrow();
  });
  it("timeout", async () => {
    await expect(http({ url: `${base}/hang`, timeoutMs: 100 })).rejects.toThrow("Request timed out after 100 ms");
  });
  it("cancel", async () => {
    const ac = new AbortController();
    const p = http({ url: `${base}/hang` }, {}, ctx(ac.signal));
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow("Aborted");
  });
});

describe("registry and metadata", () => {
  it("54 blocks: MVP + analogues of n8n core nodes + Telegram + Code Agent, tools and a memory bank", () => {
    expect(Object.keys(registry).sort()).toEqual([
      "activation_trigger", "aggregate", "atlassian", "branch", "call_trigger", "code", "code_agent", "compare_datasets", "counter", "crypto", "datetime", "error_trigger", "every",
      "files", "filter", "group", "http_request", "jwt", "limit", "local_file_trigger", "log", "loop", "loop_break", "mail", "mail_trigger", "manual", "memory_bank", "merge", "noop", "note", "notify", "remove_duplicates",
      "rename_keys", "respond_to_webhook", "result", "run_flow", "set", "shell", "sort", "source", "split_out", "stop_and_error",
      "summarize", "switch", "telegram", "telegram_trigger", "tool_calculator", "tool_code", "tool_datetime", "tool_random",
      "transform", "wait", "webhook", "workflow_trigger",
    ]);
  });
  it("registry key = static type; metadata is filled in", () => {
    for (const [key, cls] of Object.entries(registry)) {
      expect(cls.type).toBe(key);
      expect(cls.label).toBeTruthy();
      expect(cls.icon).toBeTruthy();
      expect(cls.category).toBeTruthy();
      expect(cls.ports).toBeDefined();
    }
  });
  it("Result has no outputs; Branch has two outputs", () => {
    expect(registry["result"]!.ports.outputs).toEqual([]);
    expect(registry["branch"]!.ports.outputs.map((p) => p.id)).toEqual(["out0", "out1"]);
  });
  it("blocks' default parameters pass their own validation (except required ones without a default)", () => {
    for (const cls of Object.values(registry)) {
      for (const issue of validateParams(cls.params, {})) {
        const p = cls.params.find((x) => x.name === issue.param)!;
        expect(issue.code, `${cls.type}.${p.name}`).toBe("required");
        expect(p.default, `${cls.type}.${p.name}`).toBeUndefined();
      }
    }
    expect(validateParams(registry["http_request"]!.params, {}).map((i) => i.param)).toEqual(["url"]);
  });
  it("ports and parameters are consistent: ids are unique, label outputs have no duplicates, parameter names are unique", () => {
    for (const cls of Object.values(registry)) {
      const ids = [...cls.ports.inputs, ...cls.ports.outputs].map((p) => p.id);
      expect(new Set(ids).size, cls.type).toBe(ids.length);
      const names = cls.params.map((p) => p.name);
      expect(new Set(names).size, cls.type).toBe(names.length);
      for (const p of cls.params) if (p.type === "enum") expect(p.options.some((o) => o.value === p.default) || p.default === undefined, `${cls.type}.${p.name}`).toBe(true);
    }
  });
  it("no block imports node-only at module level (dynamic imports inside run)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/^import .* from "node:/m);
    }
  });
  it("the code-editor parameter exists only in blocks that execute code from a flow (Code, Code Agent, Code Tool)", () => {
    const withEditor = Object.values(registry).filter((c) => c.params.some((p) => p.editor === "code"));
    expect(withEditor.map((c) => c.type).sort()).toEqual(["code", "code_agent", "tool_code"]);
    // and only they are marked expressions: false: templates are not substituted into code
    for (const c of withEditor) expect(c.params.find((p) => p.editor === "code")?.expressions).toBe(false);
  });
});

describe("showWhen: conditional visibility of parameters", () => {
  const schema: import("@fl0w/schema").ParamSchema[] = [
    { name: "op", type: "enum", default: "a", options: [{ value: "a" }, { value: "b" }] },
    { name: "onlyA", type: "string", required: true, showWhen: { param: "op", in: ["a"] } },
    { name: "onlyB", type: "number", required: true, showWhen: { param: "op", in: ["b"] } },
    { name: "both", type: "string", showWhen: { param: "op", in: ["a", "b"] } },
  ];
  it("isParamVisible accounts for the value and the default of the controlling parameter", () => {
    expect(isParamVisible(schema[1]!, resolveParams(schema, {}))).toBe(true); // op is a by default
    expect(isParamVisible(schema[1]!, resolveParams(schema, { op: "b" }))).toBe(false);
    expect(isParamVisible(schema[2]!, resolveParams(schema, { op: "b" }))).toBe(true);
    expect(isParamVisible(schema[0]!, {})).toBe(true); // visible always when there is no condition
    expect(isParamVisible(schema[1]!, { op: 5 })).toBe(false); // not a string: the condition is not met
  });
  it("required is checked only for visible parameters", () => {
    expect(validateParams(schema, {}).map((i) => i.param)).toEqual(["onlyA"]);
    expect(validateParams(schema, { op: "b" }).map((i) => i.param)).toEqual(["onlyB"]);
    expect(validateParams(schema, { op: "a", onlyA: "x" })).toEqual([]);
  });
  it("the type of a hidden parameter is not checked", () => {
    expect(validateParams(schema, { op: "a", onlyA: "x", onlyB: "не число" })).toEqual([]);
    expect(validateParams(schema, { op: "b", onlyB: "не число" }).map((i) => i.code)).toEqual(["type"]);
  });
});

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
/** Вызов через базовый тип: у наследников `run` может принимать меньше аргументов, чем у Block. */
const call = (b: Block, inputs: Record<string, Json>, params: Record<string, Json>, c = ctx()) =>
  b.run(inputs, params, c);
const withDefaults = (cls: typeof Transform | typeof Branch | typeof HttpRequest | typeof Merge, p: Record<string, Json>) =>
  resolveParams(cls.params, p);

describe("getPath / deepEqual", () => {
  const v = { a: { b: [10, { c: 1 }] }, "": 5 };
  it("пути", () => {
    expect(getPath(v, "a.b.0")).toBe(10);
    expect(getPath(v, "a.b.1.c")).toBe(1);
    expect(getPath(v, "")).toBe(v);
    expect(getPath(v, ".")).toBe(v);
    expect(getPath(v, "a.zzz")).toBeUndefined();
    expect(getPath(v, "a.b.x")).toBeUndefined();
    expect(getPath(5, "a")).toBeUndefined();
  });
  it("не читает прототип", () => {
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
    ["gt", "3", 2, false], // разные типы не сравниваются
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
  it("неизвестный оператор", () => {
    expect(() => evalCondition(1, "regex", 1)).toThrow(/Unknown operator/);
  });
});

describe("Source / Branch", () => {
  it("Source отдаёт заданный JSON", async () => {
    expect(await call(new Source(), {}, { json: { a: 1 } })).toEqual({ out0: { a: 1 } });
  });

  const branch = (p: Record<string, Json>, v: Json) =>
    call(new Branch(), { in0: v }, withDefaults(Branch, p));

  it("true → out0, false → out1; другой порт без ключа", async () => {
    expect(await branch({ field: "n", operator: "gt", value: 5 }, { n: 9 })).toEqual({ out0: { n: 9 } });
    expect(await branch({ field: "n", operator: "gt", value: 5 }, { n: 1 })).toEqual({ out1: { n: 1 } });
  });
  it("по умолчанию — truthy от всего входа", async () => {
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

  it("map без fields — элементы как есть", async () => {
    expect(await tr({ mode: "map" })).toEqual({ out0: items });
  });
  it("map: fields собирает объекты по путям", async () => {
    const out = await tr({ mode: "map", fields: { id: "id", score: "meta.score", self: "." } });
    expect((out["out0"] as Json[])[0]).toEqual({ id: 1, score: 5, self: items[0] });
    expect((out["out0"] as { score: Json }[])[2]!.score).toBeNull(); // нет пути → null
  });
  it("path указывает на массив внутри входа", async () => {
    const out = await tr({ mode: "map", path: "data.rows", fields: { n: "id" } }, { data: { rows: items } });
    expect(out["out0"]).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
  it("filter по условию", async () => {
    expect(await tr({ mode: "filter", field: "meta.score", operator: "gt", value: 6 })).toEqual({ out0: [items[1]] });
    expect(await tr({ mode: "filter", field: "tags", operator: "contains", value: "x" })).toEqual({
      out0: [items[0], items[2]],
    });
    expect(await tr({ mode: "filter", field: "meta.score", operator: "exists" })).toEqual({
      out0: [items[0], items[1]],
    });
  });
  it("не массив → понятная ошибка", async () => {
    await expect(tr({ mode: "map" }, { a: 1 })).rejects.toThrow('Value at "." is not an array');
    await expect(tr({ mode: "map", path: "a" }, { a: 1 })).rejects.toThrow('Value at "a" is not an array');
  });
  it("кривые fields → ошибка", async () => {
    await expect(tr({ mode: "map", fields: [1] })).rejects.toThrow(/fields/);
    await expect(tr({ mode: "map", fields: { a: 1 } })).rejects.toThrow(/path string/);
  });
});

describe("Merge", () => {
  const merge = (mode: string, inputs: Record<string, Json>) =>
    call(new Merge(), inputs, resolveParams(Merge.params, { mode }));

  it("array — значения в порядке портов", async () => {
    expect(await merge("array", { in2: "c", in0: "a", in10: "z", in1: "b" })).toEqual({ out0: ["a", "b", "c", "z"] });
  });
  it("object — по id портов", async () => {
    expect(await merge("object", { in1: 2, in0: 1 })).toEqual({ out0: { in0: 1, in1: 2 } });
  });
  it("assign — поздний вход перекрывает ранний", async () => {
    expect(await merge("assign", { in1: { a: 2, c: 3 }, in0: { a: 1, b: 1 } })).toEqual({ out0: { a: 2, b: 1, c: 3 } });
  });
  it("concat — склеивает массивы", async () => {
    expect(await merge("concat", { in0: [1], in1: [2, 3] })).toEqual({ out0: [1, 2, 3] });
  });
  it("assign/concat с неподходящим типом — понятная ошибка", async () => {
    await expect(merge("assign", { in0: { a: 1 }, in1: [1] })).rejects.toThrow('Input "in1" is not an object');
    await expect(merge("assign", { in0: null })).rejects.toThrow('Input "in0" is not an object');
    await expect(merge("concat", { in0: [1], in1: { a: 1 } })).rejects.toThrow('Input "in1" is not an array');
  });
  it("без подключённых входов — пустой результат режима", async () => {
    expect(await merge("array", {})).toEqual({ out0: [] });
    expect(await merge("object", {})).toEqual({ out0: {} });
  });
  it("не мутирует входные данные", async () => {
    const a = { x: 1 };
    await merge("assign", { in0: a, in1: { y: 2 } });
    expect(a).toEqual({ x: 1 });
  });
});

describe("Every (триггер)", () => {
  it("период в мс по единицам", () => {
    expect(Every.intervalMs({ interval: 5, unit: "seconds" })).toBe(5000);
    expect(Every.intervalMs({ interval: 2, unit: "minutes" })).toBe(120_000);
    expect(Every.intervalMs({ interval: 1.5, unit: "hours" })).toBe(5_400_000);
    expect(Every.intervalMs({})).toBe(60_000); // defaults: 1 minute
  });
  it("кривые значения → ошибка", () => {
    expect(() => Every.intervalMs({ interval: 1, unit: "weeks" })).toThrow(/Unknown unit/);
    expect(() => Every.intervalMs({ interval: 0, unit: "seconds" })).toThrow(/positive/);
    expect(() => Every.intervalMs({ interval: -3, unit: "seconds" })).toThrow(/positive/);
  });
  it("min/max у interval проверяются как параметры", () => {
    expect(validateParams(Every.params, { interval: 0 }).map((i) => i.code)).toEqual(["range"]);
    expect(validateParams(Every.params, { interval: 100_001 }).map((i) => i.code)).toEqual(["range"]);
    expect(validateParams(Every.params, { interval: 1, unit: "minutes" })).toEqual([]);
    expect(validateParams(Every.params, {})).toEqual([]);
  });
  it("без входов; триггером является только Every", () => {
    expect(Every.ports.inputs).toEqual([]);
    expect(Object.values(registry).filter((c) => c.isTrigger).map((c) => c.type).sort()).toEqual([
      "activation_trigger", "call_trigger", "error_trigger", "every", "local_file_trigger", "manual", "telegram_trigger", "webhook", "workflow_trigger",
    ]);
    expect(Object.values(registry).filter((c) => c.autoTrigger).map((c) => c.type).sort()).toEqual([
      "activation_trigger", "call_trigger", "error_trigger", "every", "local_file_trigger", "telegram_trigger", "webhook", "workflow_trigger",
    ]);
    // ждут внешнего события — ручной запуск их не стартует (Every и Manual стартуют)
    expect(Object.values(registry).filter((c) => c.eventDriven).map((c) => c.type).sort()).toEqual([
      "activation_trigger", "call_trigger", "error_trigger", "local_file_trigger", "telegram_trigger", "webhook", "workflow_trigger",
    ]);
    expect(Object.values(registry).filter((c) => c.type !== "every").every((c) => c.intervalMs({}) === null)).toBe(true);
  });
  it("run отдаёт метку времени", async () => {
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
  it("POST: тело из params", async () => {
    const out = await http({ method: "POST", url: `${base}/json`, body: { a: 1 } });
    expect(out["out0"]).toMatchObject({ method: "POST", body: '{"a":1}', ct: "application/json" });
  });
  it("POST: без body берёт вход in0", async () => {
    const out = await http({ method: "POST", url: `${base}/json` }, { in0: { from: "input" } });
    expect(out["out0"]).toMatchObject({ body: '{"from":"input"}' });
  });
  it("GET игнорирует тело", async () => {
    const out = await http({ url: `${base}/json`, body: { a: 1 } });
    expect(out["out0"]).toMatchObject({ method: "GET", body: "" });
  });
  it("пустой ответ → null", async () => {
    expect(await http({ url: `${base}/empty` })).toEqual({ out0: null });
  });
  it("не-2xx → ошибка со статусом и началом тела", async () => {
    await expect(http({ url: `${base}/500` })).rejects.toThrow("HTTP 500 Boom: server exploded");
    await expect(http({ url: `${base}/404x` })).rejects.toThrow(/HTTP 404/);
  });
  it("не JSON → ошибка", async () => {
    await expect(http({ url: `${base}/text` })).rejects.toThrow("Response is not valid JSON");
  });
  it("только http(s) и валидный URL", async () => {
    await expect(http({ url: "file:///etc/passwd" })).rejects.toThrow(/Unsupported protocol/);
    await expect(http({ url: "not a url" })).rejects.toThrow();
  });
  it("таймаут", async () => {
    await expect(http({ url: `${base}/hang`, timeoutMs: 100 })).rejects.toThrow("Request timed out after 100 ms");
  });
  it("отмена", async () => {
    const ac = new AbortController();
    const p = http({ url: `${base}/hang` }, {}, ctx(ac.signal));
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow("Aborted");
  });
});

describe("реестр и метаданные", () => {
  it("50 блоков: MVP + аналоги core-нод n8n + Telegram + Code Agent, инструменты и банк памяти", () => {
    expect(Object.keys(registry).sort()).toEqual([
      "activation_trigger", "aggregate", "branch", "call_trigger", "code", "code_agent", "compare_datasets", "counter", "crypto", "datetime", "error_trigger", "every",
      "files", "filter", "group", "http_request", "jwt", "limit", "local_file_trigger", "log", "manual", "memory_bank", "merge", "noop", "note", "remove_duplicates",
      "rename_keys", "respond_to_webhook", "result", "run_flow", "set", "shell", "sort", "source", "split_out", "stop_and_error",
      "summarize", "switch", "telegram", "telegram_trigger", "tool_calculator", "tool_code", "tool_datetime", "tool_random",
      "transform", "wait", "webhook", "workflow_trigger",
    ]);
  });
  it("ключ реестра = static type; метаданные заполнены", () => {
    for (const [key, cls] of Object.entries(registry)) {
      expect(cls.type).toBe(key);
      expect(cls.label).toBeTruthy();
      expect(cls.icon).toBeTruthy();
      expect(cls.category).toBeTruthy();
      expect(cls.ports).toBeDefined();
    }
  });
  it("Result — без выходов; Branch — два выхода", () => {
    expect(registry["result"]!.ports.outputs).toEqual([]);
    expect(registry["branch"]!.ports.outputs.map((p) => p.id)).toEqual(["out0", "out1"]);
  });
  it("default-параметры блоков проходят собственную валидацию (кроме обязательных без default)", () => {
    for (const cls of Object.values(registry)) {
      for (const issue of validateParams(cls.params, {})) {
        const p = cls.params.find((x) => x.name === issue.param)!;
        expect(issue.code, `${cls.type}.${p.name}`).toBe("required");
        expect(p.default, `${cls.type}.${p.name}`).toBeUndefined();
      }
    }
    expect(validateParams(registry["http_request"]!.params, {}).map((i) => i.param)).toEqual(["url"]);
  });
  it("порты и параметры согласованы: id уникальны, у выходов-меток нет дублей, имена параметров уникальны", () => {
    for (const cls of Object.values(registry)) {
      const ids = [...cls.ports.inputs, ...cls.ports.outputs].map((p) => p.id);
      expect(new Set(ids).size, cls.type).toBe(ids.length);
      const names = cls.params.map((p) => p.name);
      expect(new Set(names).size, cls.type).toBe(names.length);
      for (const p of cls.params) if (p.type === "enum") expect(p.options.some((o) => o.value === p.default) || p.default === undefined, `${cls.type}.${p.name}`).toBe(true);
    }
  });
  it("все блоки не импортируют node-only на уровне модуля (динамические import внутри run)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/^import .* from "node:/m);
    }
  });
  it("параметр-редактор кода только у блоков, исполняющих код из флоу (Code, Code Agent, Code Tool)", () => {
    const withEditor = Object.values(registry).filter((c) => c.params.some((p) => p.editor === "code"));
    expect(withEditor.map((c) => c.type).sort()).toEqual(["code", "code_agent", "tool_code"]);
    // и только они помечены expressions: false — шаблоны в код не подставляются
    for (const c of withEditor) expect(c.params.find((p) => p.editor === "code")?.expressions).toBe(false);
  });
});

describe("showWhen — условная видимость параметров", () => {
  const schema: import("@fl0w/schema").ParamSchema[] = [
    { name: "op", type: "enum", default: "a", options: [{ value: "a" }, { value: "b" }] },
    { name: "onlyA", type: "string", required: true, showWhen: { param: "op", in: ["a"] } },
    { name: "onlyB", type: "number", required: true, showWhen: { param: "op", in: ["b"] } },
    { name: "both", type: "string", showWhen: { param: "op", in: ["a", "b"] } },
  ];
  it("isParamVisible учитывает значение и default управляющего параметра", () => {
    expect(isParamVisible(schema[1]!, resolveParams(schema, {}))).toBe(true); // op по умолчанию a
    expect(isParamVisible(schema[1]!, resolveParams(schema, { op: "b" }))).toBe(false);
    expect(isParamVisible(schema[2]!, resolveParams(schema, { op: "b" }))).toBe(true);
    expect(isParamVisible(schema[0]!, {})).toBe(true); // без условия виден всегда
    expect(isParamVisible(schema[1]!, { op: 5 })).toBe(false); // не строка — условие не выполнено
  });
  it("обязательность проверяется только у видимых параметров", () => {
    expect(validateParams(schema, {}).map((i) => i.param)).toEqual(["onlyA"]);
    expect(validateParams(schema, { op: "b" }).map((i) => i.param)).toEqual(["onlyB"]);
    expect(validateParams(schema, { op: "a", onlyA: "x" })).toEqual([]);
  });
  it("тип скрытого параметра не проверяется", () => {
    expect(validateParams(schema, { op: "a", onlyA: "x", onlyB: "не число" })).toEqual([]);
    expect(validateParams(schema, { op: "b", onlyB: "не число" }).map((i) => i.code)).toEqual(["type"]);
  });
});

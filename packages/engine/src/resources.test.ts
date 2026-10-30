import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registry } from "@fl0w/blocks";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { participatingNodes } from "./participants";
import { dataView, edgeKind } from "./resources";
import { collect, edge, flow, node } from "./test-helpers";
import { validateFlow } from "./validate";

let memDir: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["FL0W_MEMORY_DIR"];
  memDir = mkdtempSync(path.join(tmpdir(), "fl0w-eng-mem-"));
  process.env["FL0W_MEMORY_DIR"] = memDir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["FL0W_MEMORY_DIR"];
  else process.env["FL0W_MEMORY_DIR"] = saved;
  rmSync(memDir, { recursive: true, force: true });
});

/** Source → Code Agent(code) → Result, плюс подключённые ресурсы. */
const agentFlow = (code: string, resources: { node: ReturnType<typeof node>; port: string; target?: string }[] = [], source: Json = { x: 1 }) =>
  flow(
    [node("s", "source", { json: source }), node("a", "code_agent", { code }), node("r", "result"), ...resources.map((x) => x.node)],
    [edge("s", "a"), edge("a", "r"), ...resources.map((x) => edge(x.node.id, "a", x.port, x.target ?? (x.port === "memory" ? "memory" : "tools")))],
  );
const run = (f: ReturnType<typeof flow>) => collect(f, { registry });
const logs = (events: RunnerEvent[], nodeId = "a") => events.flatMap((e) => (e.event === "node:log" && e.nodeId === nodeId ? [e.message] : []));
const tool = (id: string, type: string, params: Record<string, Json> = {}) => ({ node: node(id, type, params), port: "tool" });

describe("валидация ресурсных рёбер", () => {
  const ok = (f: unknown) => validateFlow(f, registry);

  it("инструмент и память подключаются к своим портам; несколько инструментов — на один порт", () => {
    const f = agentFlow("return { out0: 1 }", [tool("t1", "tool_calculator"), tool("t2", "tool_datetime", { name: "now" }), { node: node("m", "memory_bank"), port: "memory" }]);
    expect(ok(f).ok).toBe(true);
  });

  it("порты разного вида не соединяются", () => {
    const f = agentFlow("return { out0: 1 }", [{ node: node("t", "tool_calculator"), port: "tool", target: "memory" }]);
    const r = ok(f);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("port_kind");
    // инструмент в порт данных, данные в порт инструмента
    expect(ok(agentFlow("x", [{ node: node("t", "tool_calculator"), port: "tool", target: "in0" }])).ok).toBe(false);
    const dataToTool = flow([node("s", "source", { json: 1 }), node("a", "code_agent")], [edge("s", "a", "out0", "tools")]);
    const r2 = ok(dataToTool);
    expect(!r2.ok && r2.issues.map((i) => i.code)).toContain("port_kind");
  });

  it("порт без multiple по-прежнему принимает одно ребро; с multiple — много", () => {
    const two = flow([node("s1", "source", { json: 1 }), node("s2", "source", { json: 2 }), node("r", "result")], [edge("s1", "r"), edge("s2", "r")]);
    const r = ok(two);
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("port_occupied");
    const tools = agentFlow("x", [tool("t1", "tool_calculator"), tool("t2", "tool_random"), tool("t3", "tool_datetime")]);
    expect(ok(tools).ok).toBe(true);
  });

  it("ресурсные рёбра не образуют циклов данных", () => {
    expect(ok(agentFlow("x", [tool("t", "tool_calculator")])).ok).toBe(true);
    const k = agentFlow("x", [tool("t", "tool_calculator")]);
    expect(edgeKind(k, registry, k.edges.find((e) => e.source === "t")!)).toBe("tool");
    expect(dataView(k, registry).edges.map((e) => e.source).sort()).toEqual(["a", "s"]);
  });

  it("параметры ресурса проверяются при валидации флоу", () => {
    const f = agentFlow("x", [{ node: node("m", "memory_bank", { driver: "mongo" }), port: "memory" }]);
    const r = ok(f);
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("param_enum");
  });
});

describe("запуск: ресурсы не часть потока данных", () => {
  it("ресурсные ноды сами не запускаются и не считаются стартовыми", async () => {
    const f = agentFlow("return { out0: inputs.in0 }", [tool("t", "tool_calculator")]);
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.started).toEqual(["s", "a", "r"]);
    expect([...participatingNodes(f, registry)].sort()).toEqual(["a", "r", "s"]);
  });

  it("при триггерах ресурсы тоже не участвуют; ветка запуска не включает ресурсы", () => {
    const f = flow(
      [node("m", "manual"), node("a", "code_agent"), node("t", "tool_calculator"), node("r", "result")],
      [edge("m", "a"), edge("a", "r"), edge("t", "a", "tool", "tools")],
    );
    expect([...participatingNodes(f, registry, "m")].sort()).toEqual(["a", "m", "r"]);
  });

  it("хозяин без подключённых ресурсов запускается: tools пуст, memory не определена", async () => {
    const r = await run(agentFlow("return { out0: { n: tools.list().length, mem: typeof memory, banks: Object.keys(memories).length } }"));
    expect(r.done?.result).toEqual({ n: 0, mem: "undefined", banks: 0 });
  });
});

describe("Code Agent: инструменты", () => {
  it("список, вызов по имени и короткий вызов tools.run.<имя>", async () => {
    const code = `
      const list = tools.list().map((t) => t.name).sort()
      const a = await tools.call("calculator", { expression: "6 * 7" })
      const b = await tools.run.current_datetime({ timezone: "UTC" })
      return { out0: { list, a: a.result, b: b.timezone } }`;
    const r = await run(agentFlow(code, [tool("t1", "tool_calculator"), tool("t2", "tool_datetime")]));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ list: ["calculator", "current_datetime"], a: 42, b: "UTC" });
  });

  it("вызовы инструментов попадают в лог хозяина (в том числе неудачные) и усекаются", async () => {
    const code = `
      await tools.call("calculator", { expression: "1+1" })
      try { await tools.call("calculator", { expression: "1/0" }) } catch (e) { log("caught: " + e.message) }
      return { out0: 1 }`;
    const r = await run(agentFlow(code, [tool("t", "tool_calculator")]));
    expect(logs(r.events)).toEqual([
      'tool calculator({"expression":"1+1"}) → {"expression":"1+1","result":2}',
      'tool calculator({"expression":"1/0"}) failed: Division by zero at position 4',
      "caught: Division by zero at position 4",
    ]);
  });

  it("неизвестный инструмент — ошибка с перечнем доступных, нода падает с понятным текстом", async () => {
    const r = await run(agentFlow('await tools.call("nope", {}); return { out0: 1 }', [tool("t", "tool_calculator")]));
    expect(r.done?.error).toMatch(/Unknown tool "nope". Available: calculator/);
  });

  it("одинаковые имена инструментов — ошибка хозяина, а не тихая перезапись", async () => {
    const r = await run(agentFlow("return { out0: 1 }", [tool("t1", "tool_calculator"), tool("t2", "tool_calculator")]));
    expect(r.done?.error).toMatch(/Duplicate tool name "calculator"/);
  });

  it("параметры инструмента с выражениями по входам хозяина и повторная проверка", async () => {
    const f = agentFlow("const t = await tools.call('tz', {}); return { out0: t.timezone }", [tool("t", "tool_datetime", { name: "tz", timezone: "{{ inputs.in0.zone }}" })], { zone: "Asia/Tokyo" });
    expect((await run(f)).done?.result).toBe("Asia/Tokyo");
    const bad = agentFlow("return { out0: 1 }", [tool("t", "tool_code", { name: "x", timeoutMs: "{{ inputs.in0.zone }}" })], { zone: "abc" });
    expect((await run(bad)).done?.error).toMatch(/Node "t".*number/);
  });

  it("неверное имя инструмента отвергается", async () => {
    const r = await run(agentFlow("return { out0: 1 }", [tool("t", "tool_calculator", { name: "bad name" })]));
    expect(r.done?.error).toMatch(/Invalid tool name/);
  });

  it("свой инструмент на коде: аргументы и результат", async () => {
    const t = tool("c", "tool_code", { name: "greet", code: "return { out0: 'hi ' + inputs.in0.who }" });
    const r = await run(agentFlow("return { out0: await tools.call('greet', { who: 'Ann' }) }", [t]));
    expect(r.done?.result).toBe("hi Ann");
  });
});

describe("Code Agent: память", () => {
  const mem = (name: string) => ({ node: node(`m_${name}`, "memory_bank", { driver: "json", name }), port: "memory" });

  it("get/set/append/keys/delete/clear и первый банк как memory", async () => {
    const code = `
      await memory.set("a", { n: 1 })
      await memory.append("log", "x"); await memory.append("log", "y", 1)
      const keys = (await memory.keys()).sort()
      const got = await memory.get("a")
      const del = await memory.delete("a")
      const after = await memory.get("a")
      await memory.clear()
      return { out0: { keys, got, del, after, left: await memory.keys(), name: memory.name, driver: memory.driver } }`;
    const r = await run(agentFlow(code, [mem("eng_ops")]));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ keys: ["a", "log"], got: { n: 1 }, del: true, after: null, left: [], name: "eng_ops", driver: "json" });
  });

  it("несколько банков: memories по имени, память переживает запуск", async () => {
    const code = `
      const a = await memories.one.get("v"); const b = await memories.two.get("v")
      await memories.one.set("v", (a ?? 0) + 1); await memories.two.set("v", (b ?? 0) + 10)
      return { out0: { a, b, first: memory.name } }`;
    const res = [mem("eng_one"), mem("eng_two")].map((x, i) => ({ ...x, node: { ...x.node, id: `m${i}`, params: { driver: "json", name: i ? "two" : "one" } } }));
    const f = agentFlow(code, res);
    expect((await run(f)).done?.result).toEqual({ a: null, b: null, first: "one" });
    expect((await run(f)).done?.result).toEqual({ a: 1, b: 10, first: "one" });
  });

  it("ошибка банка (например, ключ __proto__) — исключение в коде, которое можно перехватить", async () => {
    const code = 'try { await memory.set("__proto__", 1) } catch (e) { return { out0: e.message } }; return { out0: "no error" }';
    expect((await run(agentFlow(code, [mem("eng_err")]))).done?.result).toMatch(/not allowed/);
  });
});

describe("Code Agent: граница песочницы", () => {
  it("tools/memory/memories заморожены и не дают выхода к хосту", async () => {
    const code = `
      const out = {}
      try { tools.call = () => 1 } catch {}
      out.frozen = Object.isFrozen(tools) && Object.isFrozen(tools.run)
      out.proc = typeof process
      const probes = [
        () => tools.call.constructor("return process")(),
        () => tools.list.constructor("return process")(),
        () => memories.constructor.constructor("return process")(),
        () => (async () => {}).constructor("return process")(),
      ]
      out.escaped = await Promise.all(probes.map(async (p) => { try { const v = await p(); return typeof v === "object" && v !== null && typeof v.exit === "function" } catch { return false } }))
      const t = await tools.call("calculator", { expression: "1+1" })
      out.still = t.result
      return { out0: out }`;
    const r = await run(agentFlow(code, [tool("t", "tool_calculator")]));
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ frozen: true, proc: "undefined", escaped: [false, false, false, false], still: 2 });
  });

  it("код выражений: шаблоны в code не подставляются, ресурсы без хозяина-кода недоступны обычному Code", async () => {
    const f = flow([node("s", "source", { json: { x: 1 } }), node("c", "code", { code: "return { out0: { t: typeof tools, m: typeof memory } }" }), node("r", "result")], [edge("s", "c"), edge("c", "r")]);
    expect((await run(f)).done?.result).toEqual({ t: "undefined", m: "undefined" });
  });
});

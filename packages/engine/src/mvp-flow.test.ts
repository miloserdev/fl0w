import { describe, expect, it } from "vitest";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { runFlowInProcess } from "./spawn";
import { edge, flow, node } from "./test-helpers";

/** Всё через настоящий процесс-раннер и настоящий реестр (6 блоков MVP). */
async function run(f: ReturnType<typeof flow>, timeoutMs = 20000) {
  const events: RunnerEvent[] = [];
  await runFlowInProcess(f, (e) => events.push(e), { timeoutMs });
  const done = events.at(-1);
  return {
    events,
    done: done?.event === "flow:done" ? done : undefined,
    started: events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : [])),
  };
}

const code = (id: string, body: string, extra: Record<string, Json> = {}) =>
  node(id, "code", { code: body, ...extra });

const users = [
  { name: "ann", age: 31 },
  { name: "bob", age: 17 },
  { name: "cat", age: 45 },
];

describe("MVP-блоки в отдельном процессе", () => {
  it("Source → Transform(filter) → Transform(map) → Result", async () => {
    const f = flow(
      [
        node("src", "source", { json: { users } }),
        node("adults", "transform", { mode: "filter", path: "users", field: "age", operator: "gte", value: 18 }),
        node("names", "transform", { mode: "map", fields: { who: "name" } }),
        node("res", "result"),
      ],
      [edge("src", "adults"), edge("adults", "names"), edge("names", "res")],
    );
    const { done } = await run(f);
    expect(done).toEqual({ event: "flow:done", result: [{ who: "ann" }, { who: "cat" }] });
  });

  it("Branch: идёт только взятая ветка, вторая пропускается", async () => {
    const f = flow(
      [
        node("src", "source", { json: { n: 10 } }),
        node("br", "branch", { field: "n", operator: "gt", value: 5 }),
        code("big", `return { out0: { size: "big", n: inputs.in0.n } }`),
        code("small", `return { out0: { size: "small" } }`),
        node("rBig", "result"),
        node("rSmall", "result"),
      ],
      [
        edge("src", "br"),
        edge("br", "big", "out0", "in0"),
        edge("br", "small", "out1", "in0"),
        edge("big", "rBig"),
        edge("small", "rSmall"),
      ],
    );
    const { started, done } = await run(f);
    expect(started).toEqual(["src", "br", "big", "rBig"]);
    expect(done?.result).toEqual({ size: "big", n: 10 });
  });

  it("Code-блок получает inputs/params и пишет результат", async () => {
    const f = flow(
      [
        node("src", "source", { json: [1, 2, 3] }),
        code("sum", `return { out0: { total: inputs.in0.reduce((a, b) => a + b, 0) * params.k } }`, { k: 2 }),
        node("res", "result"),
      ],
      [edge("src", "sum"), edge("sum", "res")],
    );
    expect((await run(f)).done?.result).toEqual({ total: 12 });
  });

  it("Code: require / process недоступны — node:error, раннер жив", async () => {
    for (const body of [`return { out0: require("fs").readdirSync("/") }`, `process.exit(1)`, `return { out0: process.env }`]) {
      const f = flow([code("c", body), node("res", "result")], [edge("c", "res")]);
      const { events, done } = await run(f);
      expect(events).toContainEqual({
        event: "node:error",
        nodeId: "c",
        error: expect.stringMatching(/(require|process) is not defined/),
      });
      // flow:done пришёл от самого раннера, а не как «процесс упал»
      expect(done?.error).toMatch(/^Node "c" failed: /);
      expect(done?.error).not.toMatch(/exited unexpectedly/);
    }
  });

  it("Code: бесконечный цикл обрывается по таймауту, раннер не падает", async () => {
    const f = flow(
      [node("src", "source", { json: 1 }), code("loop", `while (true) {}`, { timeoutMs: 300 }), node("res", "result")],
      [edge("src", "loop"), edge("loop", "res")],
    );
    const t = Date.now();
    const { events, started, done } = await run(f);
    expect(Date.now() - t).toBeLessThan(10000);
    expect(events).toContainEqual({
      event: "node:error",
      nodeId: "loop",
      error: expect.stringMatching(/timed out/),
    });
    expect(started).toEqual(["src", "loop"]);
    expect(done?.error).toMatch(/Node "loop" failed: .*timed out/);
    expect(done?.error).not.toMatch(/exited unexpectedly/);
  });

  it("Code: ошибка кода → node:error вместо падения", async () => {
    const f = flow([code("c", `throw new Error("custom failure")`)], []);
    const { events, done } = await run(f);
    expect(events).toContainEqual({ event: "node:error", nodeId: "c", error: "custom failure" });
    expect(done?.error).toBe('Node "c" failed: custom failure');
  });

  it("невалидные params блока отклоняются до запуска", async () => {
    const f = flow([node("t", "transform", { mode: "zip" })], []);
    const { events, done } = await run(f);
    expect(events).toHaveLength(1);
    expect(done?.error).toMatch(/Invalid flow: .*mode/);
  });

  it("HttpRequest без url отклоняется валидацией (required)", async () => {
    const { done } = await run(flow([node("h", "http_request", {})], []));
    expect(done?.error).toMatch(/Invalid flow: .*url.*required/);
  });
});

describe("Merge в отдельном процессе", () => {
  it("две ветки сводятся в один JSON (assign)", async () => {
    const f = flow(
      [
        node("a", "source", { json: { name: "Ann" } }),
        node("b", "source", { json: { visits: 12 } }),
        node("m", "merge", { mode: "assign" }),
        node("res", "result"),
      ],
      [edge("a", "m", "out0", "in0"), edge("b", "m", "out0", "in1"), edge("m", "res")],
    );
    expect((await run(f)).done?.result).toEqual({ name: "Ann", visits: 12 });
  });

  it("порядок значений — по номеру входа, а не по порядку рёбер", async () => {
    const f = flow(
      [
        node("a", "source", { json: "A" }),
        node("b", "source", { json: "B" }),
        node("m", "merge", { mode: "array" }),
        node("res", "result"),
      ],
      [edge("b", "m", "out0", "in2"), edge("a", "m", "out0", "in0"), edge("m", "res")],
    );
    expect((await run(f)).done?.result).toEqual(["A", "B"]);
  });

  it("Merge после Branch: невзятая ветка не даёт данных — Merge не запускается (wait-all)", async () => {
    const f = flow(
      [
        node("s", "source", { json: 5 }),
        node("br", "branch", { operator: "gt", value: 10 }),
        node("m", "merge"),
        node("res", "result"),
      ],
      [edge("s", "br"), edge("br", "m", "out0", "in0"), edge("br", "m", "out1", "in1"), edge("m", "res")],
    );
    const { started, done } = await run(f);
    expect(started).toEqual(["s", "br"]);
    expect(done).toEqual({ event: "flow:done" });
  });

  it("логи Code-блока приходят событиями node:log из процесса", async () => {
    const f = flow(
      [code("c", `log("hello", { a: 1 }); log("second"); return { out0: 1 }`), node("res", "result")],
      [edge("c", "res")],
    );
    const { events } = await run(f);
    const lines = events.flatMap((e) => (e.event === "node:log" ? [`${e.nodeId}:${e.message}`] : []));
    expect(lines).toEqual(['c:hello {"a":1}', "c:second"]);
  });
});

describe("порядок и своевременность событий из процесса", () => {
  it("события нод доходят ДО окончания долгого синхронного блока", async () => {
    // Code крутит синхронный цикл ~1.2 с: event loop раннера занят, но start/done предыдущих нод уже должны быть доставлены
    const f = flow(
      [
        node("src", "source", { json: 1 }),
        code("busy", `const t = Date.now(); while (Date.now() - t < 1200) {}\nreturn { out0: 1 }`),
        node("res", "result"),
      ],
      [edge("src", "busy"), edge("busy", "res")],
    );
    const at: Record<string, number> = {};
    await runFlowInProcess(f, (e) => {
      if (e.event === "node:start" || e.event === "node:done") at[`${e.event}:${e.nodeId}`] = Date.now();
    }, { timeoutMs: 20000 });

    const blocked = at["node:done:busy"]! - at["node:start:busy"]!;
    expect(blocked).toBeGreaterThan(1000); // блок действительно работал
    // src завершился и busy «стартовал» задолго до конца цикла, а не пачкой после него
    expect(at["node:done:busy"]! - at["node:done:src"]!).toBeGreaterThan(1000);
    expect(at["node:done:busy"]! - at["node:start:busy"]!).toBeGreaterThan(1000);
  });
});

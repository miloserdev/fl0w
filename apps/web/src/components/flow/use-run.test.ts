import { describe, expect, it } from "vitest";
import { beginWatchRun, IDLE_RUN, reduceRun } from "./use-run";

const ids = ["a", "b"];

describe("reduceRun: данные нод", () => {
  it("собирает вход, параметры, лог, выход и ошибку по ноде", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a", input: { in0: 1 }, params: { p: "x" } }, ids);
    s = reduceRun(s, { event: "node:log", nodeId: "a", message: "hi" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: { out0: 2 } }, ids);
    expect(s.nodeDetails["a"]).toEqual({ input: { in0: 1 }, params: { p: "x" }, logs: ["hi"], output: { out0: 2 } });
    s = reduceRun(s, { event: "node:start", nodeId: "b", input: {}, params: {} }, ids);
    s = reduceRun(s, { event: "node:error", nodeId: "b", error: "boom" }, ids);
    expect(s.nodeDetails["b"]?.error).toBe("boom");
  });

  it("повторный старт ноды стирает данные прошлого запуска этой ноды, чужие остаются", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a", input: { in0: 1 }, params: {} }, ids);
    s = reduceRun(s, { event: "node:log", nodeId: "a", message: "old" }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "b", input: {}, params: {} }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "a", input: { in0: 2 }, params: {} }, ids);
    expect(s.nodeDetails["a"]).toEqual({ input: { in0: 2 }, params: {}, logs: [] });
    expect(s.nodeDetails["b"]).toBeDefined();
  });

  it("держит не больше 200 строк лога на ноду", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a" }, ids);
    for (let i = 0; i < 250; i++) s = reduceRun(s, { event: "node:log", nodeId: "a", message: String(i) }, ids);
    expect(s.nodeDetails["a"]!.logs).toHaveLength(200);
    expect(s.nodeDetails["a"]!.logs.at(-1)).toBe("249");
  });
});

describe("Watch: новый запуск обновляет только задействованные ноды", () => {
  it("статусы, ошибки и данные прошлого запуска сохраняются, затронутая нода начинается заново", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a", input: { in0: 1 } }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: { out0: 1 } }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "b" }, ids);
    s = reduceRun(s, { event: "node:error", nodeId: "b", error: "boom" }, ids);
    s = reduceRun(s, { event: "flow:done", error: "x" }, ids);

    s = beginWatchRun(s);
    expect(s.status).toBe("running");
    expect(s.nodes).toEqual({ a: "done", b: "error" });
    expect(s.nodeDetails["a"]?.output).toEqual({ out0: 1 });
    expect(s.logs).toEqual([]);
    expect(s.result).toBeUndefined();

    s = reduceRun(s, { event: "node:start", nodeId: "b" }, ids);
    expect(s.nodes["b"]).toBe("running");
    expect(s.nodeErrors["b"]).toBeUndefined(); // ошибка прошлого запуска этой ноды снята
    expect(s.nodes["a"]).toBe("done"); // не затронутая нода не «гаснет»
  });

  it("flow:done не помечает пропущенными ноды, у которых уже есть статус из прошлых запусков", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: {} }, ids);
    s = reduceRun(s, { event: "flow:done", result: null }, ids);
    s = beginWatchRun(s);
    s = reduceRun(s, { event: "node:start", nodeId: "b" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "b", output: {} }, ids);
    s = reduceRun(s, { event: "flow:done", result: null }, ids);
    expect(s.nodes).toEqual({ a: "done", b: "done" });
  });
});

describe("Watch: сброс ветки запуска", () => {
  it("ноды ветки (involved) начинают с чистого листа, остальные сохраняют статус и ошибку", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: {} }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "b" }, ids);
    s = reduceRun(s, { event: "node:error", nodeId: "b", error: "boom" }, ids);
    const next = beginWatchRun(s, ["a"]);
    expect(next.nodes).toEqual({ b: "error" });
    expect(next.nodeErrors).toEqual({ b: "boom" });
    expect(next.nodeDetails["a"]).toBeDefined(); // данные нод не стираются
  });
});

describe("reduceRun: node:killed", () => {
  it("оборванный shoot-вызов виден в ошибках и логе, статус ноды не меняется", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "p" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "p", output: { out0: { ok: true } } }, ids);
    s = reduceRun(s, { event: "node:killed", nodeId: "p", reason: "caller finished" }, ids);
    expect(s.nodes["p"]).toBe("done");
    expect(s.nodeErrors["p"]).toBe("killed: caller finished");
    expect(s.logs.at(-1)).toEqual({ nodeId: "p", message: "killed: caller finished" });
  });
});

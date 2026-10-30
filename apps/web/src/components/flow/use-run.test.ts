import { describe, expect, it } from "vitest";
import { IDLE_RUN, reduceRun } from "./use-run";

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

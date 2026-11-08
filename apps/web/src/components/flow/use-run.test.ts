import { describe, expect, it } from "vitest";
import { beginWatchRun, IDLE_RUN, reduceRun } from "./use-run";

const ids = ["a", "b"];

describe("reduceRun: node data", () => {
  it("collects input, params, log, output and error per node", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a", input: { in0: 1 }, params: { p: "x" } }, ids);
    s = reduceRun(s, { event: "node:log", nodeId: "a", message: "hi" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: { out0: 2 } }, ids);
    expect(s.nodeDetails["a"]).toEqual({ input: { in0: 1 }, params: { p: "x" }, logs: ["hi"], output: { out0: 2 } });
    s = reduceRun(s, { event: "node:start", nodeId: "b", input: {}, params: {} }, ids);
    s = reduceRun(s, { event: "node:error", nodeId: "b", error: "boom" }, ids);
    expect(s.nodeDetails["b"]?.error).toBe("boom");
  });

  it("a repeated node start erases the previous run's data for that node, others stay", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a", input: { in0: 1 }, params: {} }, ids);
    s = reduceRun(s, { event: "node:log", nodeId: "a", message: "old" }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "b", input: {}, params: {} }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "a", input: { in0: 2 }, params: {} }, ids);
    expect(s.nodeDetails["a"]).toEqual({ input: { in0: 2 }, params: {}, logs: [] });
    expect(s.nodeDetails["b"]).toBeDefined();
  });

  it("keeps at most 200 log lines per node", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a" }, ids);
    for (let i = 0; i < 250; i++) s = reduceRun(s, { event: "node:log", nodeId: "a", message: String(i) }, ids);
    expect(s.nodeDetails["a"]!.logs).toHaveLength(200);
    expect(s.nodeDetails["a"]!.logs.at(-1)).toBe("249");
  });
});

describe("Watch: a new run updates only the nodes involved", () => {
  it("statuses, errors and data of the previous run are kept, the affected node starts anew", () => {
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
    expect(s.nodeErrors["b"]).toBeUndefined(); // the previous run's error of this node is cleared
    expect(s.nodes["a"]).toBe("done"); // an unaffected node does not "go dark"
  });

  it("flow:done does not mark as skipped nodes that already have a status from previous runs", () => {
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

describe("Watch: resetting a run branch", () => {
  it("branch nodes (involved) start from a clean slate, the rest keep status and error", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: {} }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "b" }, ids);
    s = reduceRun(s, { event: "node:error", nodeId: "b", error: "boom" }, ids);
    const next = beginWatchRun(s, ["a"]);
    expect(next.nodes).toEqual({ b: "error" });
    expect(next.nodeErrors).toEqual({ b: "boom" });
    expect(next.nodeDetails["a"]).toBeDefined(); // node data is not erased
  });
});

describe("reduceRun: node:killed", () => {
  it("an aborted shoot call is visible in errors and log, the node status does not change", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "p" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "p", output: { out0: { ok: true } } }, ids);
    s = reduceRun(s, { event: "node:killed", nodeId: "p", reason: "caller finished" }, ids);
    expect(s.nodes["p"]).toBe("done");
    expect(s.nodeErrors["p"]).toBe("killed: caller finished");
    expect(s.logs.at(-1)).toEqual({ nodeId: "p", message: "killed: caller finished" });
  });
});

describe("reduceRun: flow:done and aborted nodes", () => {
  it("a node aborted by the end of the run (left running) does not pulse forever — it becomes skipped; finished ones are untouched", () => {
    let s = reduceRun(IDLE_RUN, { event: "node:start", nodeId: "a" }, ids);
    s = reduceRun(s, { event: "node:done", nodeId: "a", output: {} }, ids);
    s = reduceRun(s, { event: "node:start", nodeId: "b" }, ids);
    const ok = reduceRun(s, { event: "flow:done", result: null }, ids);
    expect(ok.nodes).toEqual({ a: "done", b: "skipped" });
    const failed = reduceRun(s, { event: "flow:done", error: "x" }, ids);
    expect(failed.nodes).toEqual({ a: "done", b: "skipped" });
  });
});

describe("run pause", () => {
  it("run:paused sets and clears the flag, flow:done does not leave the run paused", () => {
    const running = { ...IDLE_RUN, status: "running" as const };
    const paused = reduceRun(running, { event: "run:paused", paused: true }, []);
    expect(paused.paused).toBe(true);
    expect(reduceRun(paused, { event: "run:paused", paused: false }, []).paused).toBe(false);
    expect(reduceRun(paused, { event: "flow:done", result: null }, []).paused).toBeFalsy();
  });
});

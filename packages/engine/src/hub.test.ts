import { describe, expect, it } from "vitest";
import type { WatchMessage } from "@fl0w/schema";
import { RunHub } from "./hub";

const done = { event: "flow:done" as const, result: 1 };

describe("RunHub", () => {
  it("a live subscriber receives the start and the run events in order", () => {
    const hub = new RunHub();
    const got: WatchMessage[] = [];
    hub.subscribe("f", (m) => got.push(m));
    const runId = hub.startRun("f", "t1");
    hub.publish("f", runId, { event: "node:start", nodeId: "n" });
    hub.publish("f", runId, done);
    expect(got.map((m) => m.type)).toEqual(["run:start", "run:event", "run:event"]);
    expect(got[0]).toMatchObject({ type: "run:start", runId, flowId: "f", trigger: "t1" });
  });

  it("run:start carries the run's branch nodes, both to live subscribers and on replay", () => {
    const hub = new RunHub();
    const live: WatchMessage[] = [];
    hub.subscribe("f", (m) => live.push(m));
    hub.startRun("f", "t1", ["t1", "a", "b"]);
    const late: WatchMessage[] = [];
    hub.subscribe("f", (m) => late.push(m));
    expect(live[0]).toMatchObject({ type: "run:start", nodes: ["t1", "a", "b"] });
    expect(late[0]).toMatchObject({ type: "run:start", nodes: ["t1", "a", "b"] });
    hub.startRun("g", null);
    const bare: WatchMessage[] = [];
    hub.subscribe("g", (m) => bare.push(m));
    expect(bare[0]).not.toHaveProperty("nodes");
  });

  it("a new subscriber immediately receives the last run from the start", () => {
    const hub = new RunHub();
    const runId = hub.startRun("f", "t1");
    hub.publish("f", runId, { event: "node:start", nodeId: "n" });
    const got: WatchMessage[] = [];
    hub.subscribe("f", (m) => got.push(m)); // joined mid-run
    hub.publish("f", runId, done);
    expect(got.map((m) => (m.type === "run:event" ? m.event.event : m.type))).toEqual([
      "run:start",
      "node:start",
      "flow:done",
    ]);
  });

  it("only the last run is replayed", () => {
    const hub = new RunHub();
    const first = hub.startRun("f", "t");
    hub.publish("f", first, done);
    const second = hub.startRun("f", "t");
    const got: WatchMessage[] = [];
    hub.subscribe("f", (m) => got.push(m));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "run:start", runId: second });
  });

  it("flow channels are isolated", () => {
    const hub = new RunHub();
    const got: WatchMessage[] = [];
    hub.subscribe("a", (m) => got.push(m));
    hub.publish("b", hub.startRun("b", null), done);
    expect(got).toEqual([]);
  });

  it("unsubscribing stops delivery", () => {
    const hub = new RunHub();
    const got: WatchMessage[] = [];
    const off = hub.subscribe("f", (m) => got.push(m));
    off();
    hub.startRun("f", "t");
    expect(got).toEqual([]);
  });

  it("a failing subscriber does not disturb the others", () => {
    const hub = new RunHub();
    const got: WatchMessage[] = [];
    hub.subscribe("f", () => {
      throw new Error("bad listener");
    });
    hub.subscribe("f", (m) => got.push(m));
    expect(() => hub.startRun("f", "t")).not.toThrow();
    expect(got).toHaveLength(1);
  });

  it("lastRun: status, error and finish time", () => {
    const hub = new RunHub();
    expect(hub.lastRun("f")).toBeUndefined();
    const id = hub.startRun("f", "t");
    expect(hub.lastRun("f")).toMatchObject({ runId: id, status: "running" });
    hub.publish("f", id, { event: "flow:done", error: "boom" });
    expect(hub.lastRun("f")).toMatchObject({ status: "error", error: "boom", finishedAt: expect.any(String) });
    const id2 = hub.startRun("f", "t");
    hub.publish("f", id2, done);
    expect(hub.lastRun("f")).toMatchObject({ runId: id2, status: "done" });
    expect(hub.lastRun("f")).not.toHaveProperty("events");
  });

  it("events of a foreign (stale) run do not corrupt the current summary", () => {
    const hub = new RunHub();
    const old = hub.startRun("f", "t");
    hub.startRun("f", "t");
    hub.publish("f", old, { event: "flow:done", error: "late" });
    expect(hub.lastRun("f")?.status).toBe("running");
  });

  it("skip reaches subscribers", () => {
    const hub = new RunHub();
    const got: WatchMessage[] = [];
    hub.subscribe("f", (m) => got.push(m));
    hub.skip("f", "t1", "busy");
    expect(got[0]).toMatchObject({ type: "run:skip", flowId: "f", trigger: "t1", reason: "busy" });
  });
});

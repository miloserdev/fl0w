import { describe, expect, it } from "vitest";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { participatingNodes } from "./participants";
import { runFlowInProcess } from "./spawn";
import type { RunnerEvent } from "@fl0w/schema";

const part = (f: ReturnType<typeof flow>, trigger?: string) => [...participatingNodes(f, testRegistry, trigger)].sort();

describe("participatingNodes: which nodes the run starts from", () => {
  it("without triggers, data sources start; everything reachable takes part", () => {
    const f = flow(
      [node("s", "source", { json: 1 }), node("t", "transform"), node("r", "result"), node("orphan", "transform"), node("orphanRes", "result")],
      [edge("s", "t"), edge("t", "r")],
    );
    expect(part(f)).toEqual(["r", "s", "t"]);
  });

  it("with triggers only they start: an \"extra\" Source with no link to a trigger does not take part", () => {
    const f = flow(
      [node("m", "manual"), node("r1", "result"), node("s", "source", { json: 1 }), node("r2", "result")],
      [edge("m", "r1"), edge("s", "r2")],
    );
    expect(part(f)).toEqual(["m", "r1"]);
  });

  it("a Source feeding a node after a trigger takes part", () => {
    const f = flow(
      [node("m", "manual"), node("s", "source", { json: 1 }), node("j", "join"), node("r", "result"), node("other", "source", { json: 2 })],
      [edge("m", "j", "out0", "in0"), edge("s", "j", "out0", "in1"), edge("j", "r")],
    );
    expect(part(f)).toEqual(["j", "m", "r", "s"]);
  });

  it("in a scheduled run only the chosen trigger and its branch", () => {
    const f = flow(
      [node("a", "every"), node("b", "every"), node("ra", "result"), node("rb", "result")],
      [edge("a", "ra"), edge("b", "rb")],
    );
    expect(part(f, "a")).toEqual(["a", "ra"]);
    expect(part(f)).toEqual(["a", "b", "ra", "rb"]);
  });

  it("an empty flow and a flow without start nodes: nobody takes part", () => {
    expect(part(flow([], []))).toEqual([]);
    expect(part(flow([node("t", "transform"), node("r", "result")], [edge("t", "r")]))).toEqual([]);
  });
});

describe("a run does not touch nodes unconnected to the start", () => {
  it("nodes dropped onto the canvas are not executed (previously any node without connected inputs was executed)", async () => {
    const f = flow(
      [
        node("s", "source", { json: 5 }),
        node("res", "result"),
        // "orphan" nodes: nothing is connected
        node("lone", "transform"),
        node("loneBoom", "boom"),
        node("loneRes", "result"),
        node("loneBranch", "branch"),
      ],
      [edge("s", "res")],
    );
    const { started, done } = await collect(f);
    expect(started).toEqual(["s", "res"]);
    expect(done).toEqual({ event: "flow:done", result: 5 }); // boom was not executed, otherwise there would be a flow:done with an error
  });

  it("an extra Source does not start if the flow has a trigger", async () => {
    const f = flow(
      [node("m", "manual"), node("r1", "result"), node("s", "source", { json: 1 }), node("r2", "result")],
      [edge("m", "r1"), edge("s", "r2")],
    );
    const { started } = await collect(f);
    expect(started).toEqual(["m", "r1"]);
  });

  it("a Source feeding the trigger's branch is executed", async () => {
    const f = flow(
      [node("m", "manual"), node("s", "source", { json: "B" }), node("j", "join"), node("r", "result")],
      [edge("m", "j", "out0", "in0"), edge("s", "j", "out0", "in1"), edge("j", "r")],
    );
    const { started, done } = await collect(f);
    expect(started).toEqual(["m", "s", "j", "r"]);
    expect((done?.result as { b: string }).b).toBe("B");
  });

  it("a node with ONLY some of its inputs connected waits for the rest (wait-all is preserved)", async () => {
    const f = flow(
      [node("s", "source", { json: 1 }), node("m", "merge"), node("r", "result")],
      [edge("s", "m", "out0", "in0"), edge("m", "r")], // of Merge's four inputs one is connected; it waits only for that one
    );
    const { started, done } = await collect(f);
    expect(started).toEqual(["s", "m", "r"]);
    expect(done?.result).toEqual([1]);
  });

  it("the same rule in a separate process", async () => {
    const f = flow(
      [node("s", "source", { json: 1 }), node("res", "result"), node("lone", "code", { code: "throw new Error('must not run')" }), node("loneRes", "result")],
      [edge("s", "res"), edge("lone", "loneRes")],
    );
    const events: RunnerEvent[] = [];
    await runFlowInProcess(f, (e) => void events.push(e), { timeoutMs: 20000 });
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).toEqual(["s", "res"]);
    expect(events.at(-1)).toEqual({ event: "flow:done", result: 1 });
  });
});

import { registry } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findIncoming, validateCallChannels } from "./call-channel";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { FlowStore } from "./store";
import { collect, edge, flow, node } from "./test-helpers";
import { validateFlow } from "./validate";

const off = <T extends ReturnType<typeof node>>(n: T): T => ({ ...n, disabled: true });
const run = (f: Flow, extra: Record<string, unknown> = {}) => collect(f, { registry, ...extra });

describe("disabled node", () => {
  it("takes no part in the run: not executed, outputs nothing, so the branch behind it does not go while neighbouring branches do", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), off(node("mid", "code", { code: "return { out0: 'MID' }" })), node("after", "noop"), node("r1", "result"), node("side", "noop"), node("r2", "result")],
      [edge("s", "mid"), edge("mid", "after"), edge("after", "r1"), edge("s", "side"), edge("side", "r2")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
    expect(r.started).not.toContain("mid");
    expect(r.started).not.toContain("after");
    expect(r.started).toEqual(expect.arrayContaining(["s", "side", "r2"]));
    expect(r.done?.result).toEqual({ v: 1 }); // the only Result the data reached
  });

  it("Merge any receives input from the other branches; a disabled source simply \"did not arrive\"", async () => {
    const f = flow(
      [node("a", "source", { json: { a: 1 } }), off(node("b", "source", { json: { b: 2 } })), node("m", "merge", { mode: "array", wait: "any" }), node("r", "result")],
      [edge("a", "m", "out0", "in0", "ea"), edge("b", "m", "out0", "in1", "eb"), edge("m", "r")],
    );
    expect((await run(f)).done?.result).toEqual([{ a: 1 }]);
  });

  it("a disabled trigger does not start; if all are disabled the run goes from data sources; an explicit run of a disabled one is an error", async () => {
    const f = flow(
      [off(node("m1", "manual")), node("m2", "manual"), node("c1", "code", { code: "return { out0: 1 }" }), node("c2", "code", { code: "return { out0: 2 }" }), node("r1", "result"), node("r2", "result")],
      [edge("m1", "c1"), edge("c1", "r1"), edge("m2", "c2"), edge("c2", "r2")],
    );
    const r = await run(f);
    expect(r.started).toEqual(["m2", "c2", "r2"]);
    expect((await run(f, { trigger: "m1" })).done?.error).toMatch(/Trigger "m1" is disabled/);
    // the only trigger is disabled and there are no sources: nothing to start, and this is not a "run without triggers"
    const solo = flow([off(node("m", "manual")), node("c", "noop"), node("r", "result")], [edge("m", "c"), edge("c", "r")]);
    expect((await run(solo)).started).toEqual([]);
  });

  it("parameters of a disabled node are not validated (it can be left unfinished); those of an enabled one are", () => {
    const broken = node("h", "http_request", {}); // url is required
    expect(validateFlow(flow([broken], []), registry).ok).toBe(false);
    expect(validateFlow(flow([off(broken)], []), registry).ok).toBe(true);
  });

  it("a disabled tool and memory bank are unavailable to the host; a disabled call does not occupy the channel", async () => {
    const f = flow(
      [node("s", "source", { json: { x: 1 } }), node("a", "code_agent", { code: "return { out0: { tools: tools.list().map((t) => t.name), mem: typeof memory } }" }), off(node("t", "tool_calculator")), node("t2", "tool_datetime"), node("r", "result")],
      [edge("s", "a"), edge("a", "r"), edge("t", "a", "tool", "tools", "et1"), edge("t2", "a", "tool", "tools", "et2")],
    );
    expect((await run(f)).done?.result).toEqual({ tools: ["current_datetime"], mem: "undefined" });
    const a: Flow = { ...flow([node("in", "call_trigger", { channelId: "c" })], []), id: "A" };
    const b: Flow = { ...flow([off(node("in", "call_trigger", { channelId: "c" }))], []), id: "B" };
    expect(validateCallChannels(a, [b])).toEqual([]); // a disabled Collector in another flow does not occupy the channel
    expect(findIncoming([a, b], "c").flow.id).toBe("A");
  });
});

describe("disabled trigger and the scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("the Every timer and webhook of a disabled node are not registered; enabled ones are", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: new RunHub(),
      registry,
      run: async (_f, onEvent, o) => {
        calls.push(o.trigger);
        onEvent({ event: "flow:done", result: 1 });
      },
    });
    const f: Flow = {
      ...flow(
        [off(node("ev", "every", { interval: 1, unit: "seconds" })), node("ev2", "every", { interval: 2, unit: "seconds" }), off(node("wh", "webhook", { path: "off-hook", method: "POST" })), node("wh2", "webhook", { path: "on-hook", method: "POST" }), node("r", "result")],
        [],
      ),
      id: "f",
      status: "published",
    };
    scheduler.sync(f);
    expect(scheduler.findWebhook("POST", "off-hook")).toBeUndefined();
    expect(scheduler.findWebhook("POST", "on-hook")).toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["ev2"]); // the disabled Every (1 s) did not tick
    scheduler.stop();
  });
});

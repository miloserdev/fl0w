import { registry } from "@fl0w/blocks";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { channelsOf, findIncoming, graphsOf, validateCallChannels, validateCallGraph } from "./call-channel";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { runFlowInProcess, sandboxEnv } from "./spawn";
import { FlowStore } from "./store";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { validateFlow } from "./validate";

/** The called flow: Incoming Call(channel) → [steps] → Result. */
const callee = (id: string, channel: string, middle: ReturnType<typeof node>[] = [], edges: ReturnType<typeof edge>[] = []): Flow => ({
  ...flow(
    [node("in", "call_trigger", { channelId: channel }), ...middle, node("res", "result")],
    middle.length ? [edge("in", middle[0]!.id), ...edges, edge(middle.at(-1)!.id, "res")] : [edge("in", "res")],
  ),
  id,
});
/** The caller: Source → Outgoing Call → (out0 → Result, err → Result2 optionally). */
const caller = (params: Record<string, Json>, opts: { errPort?: boolean; id?: string } = {}): Flow => ({
  ...flow(
    [node("s", "source", { json: { v: 1 } }), node("p", "run_flow", params), node("r", "result"), ...(opts.errPort ? [node("er", "result")] : [])],
    [edge("s", "p"), edge("p", "r"), ...(opts.errPort ? [edge("p", "er", "err", "in0", "e-err")] : [])],
  ),
  id: opts.id ?? "caller",
});
const code = (id: string, body: string) => node(id, "code", { code: body });
const resolverFor = (...flows: Flow[]) => async (ch: string) => findIncoming(flows, ch);
const run = (f: Flow, flows: Flow[], extra: Record<string, unknown> = {}) => collect(f, { registry, resolveCall: resolverFor(f, ...flows), ...extra });
const ev = (events: RunnerEvent[], kind: string) => events.filter((e) => e.event === kind);

describe("call pair: channels, ports, validation", () => {
  it("the err port exists only in await mode", () => {
    const await_ = validateFlow(caller({ channelId: "c", mode: "await" }, { errPort: true }), registry);
    expect(await_.ok).toBe(true);
    const shoot = validateFlow(caller({ channelId: "c", mode: "shoot" }, { errPort: true }), registry);
    expect(shoot.ok).toBe(false);
    expect(!shoot.ok && shoot.issues.map((i) => i.code)).toContain("unknown_port");
    // await mode by default
    expect(validateFlow(caller({ channelId: "c" }, { errPort: true }), registry).ok).toBe(true);
  });

  it("1:1 link: two incoming (or two outgoing) on one channel is an error, both within a flow and between flows", () => {
    const dupIn: Flow = { ...flow([node("a", "call_trigger", { channelId: "x" }), node("b", "call_trigger", { channelId: "x" }), node("r", "result")], [edge("a", "r")]), id: "d" };
    const r = validateFlow(dupIn, registry);
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("call_channel");
    const other = callee("other", "chan");
    expect(validateCallChannels(callee("mine", "chan"), [other]).map((i) => i.code)).toEqual(["call_channel"]);
    expect(validateCallChannels(callee("mine", "chan"), [callee("mine", "chan")])).toEqual([]); // the same flow: its own earlier copy
    expect(validateCallChannels(callee("mine", "chan"), [caller({ channelId: "chan" })])).toEqual([]); // the other side: this is a pair
    expect(validateCallChannels(caller({ channelId: "chan" }), [caller({ channelId: "chan" }, { id: "c2" })]).length).toBe(1);
    expect(validateCallChannels(caller({ channelId: "unpaired" }), [])).toEqual([]); // the pair may not exist yet
  });

  it("findIncoming: exactly one; none or several is a clear error; surrounding whitespace is not significant", () => {
    expect(findIncoming([callee("a", " c1 ")], "c1").triggerId).toBe("in");
    expect(() => findIncoming([callee("a", "c1")], "zzz")).toThrow(/No incoming call with channel "zzz"/);
    expect(() => findIncoming([callee("a", "c1"), callee("b", "c1")], "c1")).toThrow(/ambiguous/);
    expect(channelsOf(caller({ channelId: "k" }))).toEqual({ incoming: [], outgoing: [{ nodeId: "p", channelId: "k" }] });
  });

  it("incoming call is not a start node: a manual run does not raise it, even with pinned data", async () => {
    const f: Flow = { ...flow([{ ...node("in", "call_trigger", { channelId: "c" }), pinData: { out0: { x: 1 } } }, node("r", "result")], [edge("in", "r")]), id: "solo" };
    const r = await collect(f, { registry });
    expect(r.started).toEqual([]);
    expect(r.done?.error).toMatch(/Nothing to start manually/);
  });
});

describe("await: with confirmation", () => {
  it("out0 is the called flow's result (the value of its Result), the call data arrives in the incoming call", async () => {
    const c = callee("c", "ch", [code("m", "return { out0: { got: inputs.in0, doubled: inputs.in0.v * 2 } }")]);
    const r = await run(caller({ channelId: "ch" }), [c]);
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ got: { v: 1 }, doubled: 2 });
  });

  it("a called flow without a Result gives null; data from parameters replaces the input", async () => {
    const noResult: Flow = { ...flow([node("in", "call_trigger", { channelId: "ch" })], []), id: "nr" };
    expect((await run(caller({ channelId: "ch" }), [noResult])).done?.result).toBeNull();
    const c = callee("c", "ch", [code("m", "return { out0: inputs.in0 }")]);
    expect((await run(caller({ channelId: "ch", data: { fixed: true } }), [c])).done?.result).toEqual({ fixed: true });
  });

  it("a failure of the called flow goes to the err port (with the error text), out0 does not fire", async () => {
    const c = callee("c", "ch", [code("m", "throw new Error('callee boom')")]);
    const r = await run(caller({ channelId: "ch" }, { errPort: true }), [c]);
    expect(r.done?.error).toBeUndefined();
    const res = r.done?.result as Record<string, Json>;
    // nothing came out of out0: the only Result received the error from err
    expect(res).toMatchObject({ message: expect.stringContaining("callee boom"), channelId: "ch" });
  });

  it("the err port is connected to nothing, so the error is not lost: the node itself fails", async () => {
    const c = callee("c", "ch", [code("m", "throw new Error('lost?')")]);
    const r = await run(caller({ channelId: "ch" }), [c]);
    expect(r.done?.error).toMatch(/Node "p" failed:.*lost\?/);
  });

  it("no channel / ambiguous channel / no resolver: to err (or the node fails)", async () => {
    const r = await run(caller({ channelId: "nope" }, { errPort: true }), []);
    expect(r.done?.result).toMatchObject({ message: expect.stringMatching(/No incoming call with channel "nope"/) });
    const r2 = await collect(caller({ channelId: "x" }), { registry });
    expect(r2.done?.error).toMatch(/not available/);
  });

});

describe("await: two graphs of one flow", () => {
  it("a call to a separate incoming call of the SAME flow (not linked to the calling graph) is not recursion", async () => {
    // graph 1: Manual → Outgoing Call(norm0) → Result; graph 2 (not connected): Incoming Call(norm0) → Code → Result
    const one: Flow = {
      ...flow(
        [node("m0", "manual"), node("p", "run_flow", { channelId: "norm0", data: { v: 5 } }), node("r", "result"), node("in", "call_trigger", { channelId: "norm0" }), code("m", "return { out0: { doubled: inputs.in0.v * 2 } }"), node("r2", "result")],
        [edge("m0", "p"), edge("p", "r"), edge("in", "m"), edge("m", "r2")],
      ),
      id: "same",
    };
    const r = await collect(one, { registry, resolveCall: resolverFor(one) });
    expect(r.done?.error).toBeUndefined();
    expect(r.done?.result).toEqual({ doubled: 10 });
  });

});

describe("shoot: fire and forget", () => {
  const slowCallee = (id = "slow", ch = "ch") => callee(id, ch, [node("w", "wait", { amount: 3, unit: "seconds" })]);

  it("out0 = { ok: true } at once, does not wait for the called flow; there is no err port", async () => {
    const t0 = Date.now();
    const r = await run(caller({ channelId: "ch", mode: "shoot" }), [slowCallee()]);
    expect(Date.now() - t0).toBeLessThan(2500); // did not wait for the 3-second Wait
    expect(r.done?.result).toEqual({ ok: true });
  });

  it("if the run finished earlier, an unfinished called flow is cut off and this is written to the feed (node:killed)", async () => {
    const r = await run(caller({ channelId: "ch", mode: "shoot" }), [slowCallee()]);
    const killed = ev(r.events, "node:killed");
    expect(killed).toHaveLength(1);
    expect(killed[0]).toMatchObject({ nodeId: "p", reason: expect.stringMatching(/stopped/) });
    expect(r.done?.error).toBeUndefined(); // this does not concern the caller
    // node:killed before flow:done
    const order = r.events.map((e) => e.event);
    expect(order.indexOf("node:killed")).toBeLessThan(order.indexOf("flow:done"));
  });

  it("the called flow managed to finish: neither killed nor error", async () => {
    const quick = callee("q", "ch", [code("m", "return { out0: 1 }")]);
    const caller2: Flow = {
      ...flow([node("s", "source", { json: { v: 1 } }), node("p", "run_flow", { channelId: "ch", mode: "shoot" }), node("w", "wait", { amount: 1, unit: "seconds" }), node("r", "result")], [edge("s", "p"), edge("p", "w"), edge("w", "r")]),
      id: "c2",
    };
    const r = await run(caller2, [quick]);
    expect(ev(r.events, "node:killed")).toHaveLength(0);
    expect(ev(r.events, "node:error")).toHaveLength(0);
    expect(r.done?.result).toEqual({ ok: true });
  });

  it("a failure of the called flow is written as node:error of the calling node, but the run itself succeeds", async () => {
    const bad = callee("bad", "ch", [code("m", "throw new Error('shoot boom')")]);
    const caller2: Flow = {
      ...flow([node("s", "source", { json: { v: 1 } }), node("p", "run_flow", { channelId: "ch", mode: "shoot" }), node("w", "wait", { amount: 1, unit: "seconds" }), node("r", "result")], [edge("s", "p"), edge("p", "w"), edge("w", "r")]),
      id: "c3",
    };
    const r = await run(caller2, [bad]);
    expect(r.done?.error).toBeUndefined();
    expect(ev(r.events, "node:error")).toEqual([expect.objectContaining({ nodeId: "p", error: expect.stringMatching(/shoot call to channel "ch" failed:.*shoot boom/) })]);
  });

  it("no channel, recursion, depth: in shoot they are logged (node:error) and swallowed, the run goes on", async () => {
    const caller2: Flow = {
      ...flow([node("s", "source", { json: { v: 1 } }), node("p", "run_flow", { channelId: "missing", mode: "shoot" }), node("w", "wait", { amount: 1, unit: "seconds" }), node("r", "result")], [edge("s", "p"), edge("p", "w"), edge("w", "r")]),
      id: "c4",
    };
    const r = await run(caller2, []);
    expect(r.done?.result).toEqual({ ok: true });
    expect(ev(r.events, "node:error")[0]).toMatchObject({ nodeId: "p", error: expect.stringMatching(/No incoming call/) });
  });
});

describe("Scheduler.resolveCall: working runs find only published flows", () => {
  const scheduler = (...pub: Flow[]) => {
    const s = new Scheduler({ store: new FlowStore("/nonexistent"), hub: new RunHub(), registry: testRegistry, run: async (_f, onEvent) => onEvent({ event: "flow:done", result: 1 }) });
    for (const f of pub) s.sync({ ...f, status: "published" });
    return s;
  };

  it("finds the incoming call of a published flow and returns its definition; a draft is not visible", async () => {
    const s = scheduler(callee("pubd", "ch"));
    expect((await s.resolveCall("ch")).flow.id).toBe("pubd");
    await expect(scheduler().resolveCall("ch")).rejects.toThrow(/No incoming call/);
    s.stop();
  });
});

describe("call pair in a real process runner (IPC)", () => {
  const exec = async (f: Flow, flows: Flow[]) => {
    const events: RunnerEvent[] = [];
    await runFlowInProcess(f, (e) => events.push(e), { timeoutMs: 20000, onResolveCall: async (ch) => findIncoming(flows, ch) });
    const done = events.at(-1);
    return { events, done: done?.event === "flow:done" ? done : undefined };
  };

  it("await: the called flow's result arrives through the IPC flow definition", async () => {
    const c = callee("c", "ch", [code("m", "return { out0: { echoed: inputs.in0 } }")]);
    expect((await exec(caller({ channelId: "ch" }), [c])).done?.result).toEqual({ echoed: { v: 1 } });
  });

  it("host refusal (no channel) is a node error with its text; without onResolveCall a clear error", async () => {
    const r = await exec(caller({ channelId: "zzz" }), []);
    expect(r.done?.error).toMatch(/No incoming call with channel "zzz"/);
    const events: RunnerEvent[] = [];
    await runFlowInProcess(caller({ channelId: "zzz" }), (e) => events.push(e), { timeoutMs: 20000 });
    expect((events.at(-1) as { error?: string }).error).toMatch(/not available/);
  });

  it("shoot: the caller reached Result, the process finishes, the unfinished called flow is cut off (node:killed)", async () => {
    const slow = callee("slow", "ch", [node("w", "wait", { amount: 3, unit: "seconds" })]);
    const t0 = Date.now();
    const r = await exec(caller({ channelId: "ch", mode: "shoot" }), [slow]);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.done?.result).toEqual({ ok: true });
    expect(ev(r.events, "node:killed")).toHaveLength(1);
  });
});

describe("sandbox environment", () => {
  it("sandbox memory banks live in the nested _sandbox directory; without memory the environment is unchanged", () => {
    expect(sandboxEnv({ FL0W_MEMORY_DIR: "/data/memory" })["FL0W_MEMORY_DIR"]).toBe("/data/memory/_sandbox");
    expect(sandboxEnv({ FL0W_MEMORY_DIR: "/data/memory/" })["FL0W_MEMORY_DIR"]).toBe("/data/memory/_sandbox");
    expect(sandboxEnv({ OTHER: "1" })).toEqual({ OTHER: "1" });
  });
});

describe("sandbox: memory separate from the working one (real process runner)", () => {
  it("sandbox:true writes the bank to <memory>/_sandbox and leaves the working directory alone", async () => {
    const { mkdtempSync, existsSync, rmSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "fl0w-sbx-"));
    const saved = process.env["FL0W_MEMORY_DIR"];
    process.env["FL0W_MEMORY_DIR"] = dir;
    try {
      const f = flow(
        [node("s", "source", { json: { v: 1 } }), node("a", "code_agent", { code: 'await memory.set("k", 1); return { out0: { ok: true } }' }), node("m", "memory_bank", { name: "bank" }), node("r", "result")],
        [edge("s", "a"), edge("a", "r"), edge("m", "a", "memory", "memory")],
      );
      const run = async (sandbox: boolean) => {
        const events: RunnerEvent[] = [];
        await runFlowInProcess(f, (e) => events.push(e), { timeoutMs: 20000, sandbox });
        expect(events.at(-1)).toMatchObject({ event: "flow:done", result: { ok: true } });
      };
      await run(true);
      expect(existsSync(path.join(dir, "bank.json"))).toBe(false); // working memory untouched
      expect(existsSync(path.join(dir, "_sandbox", "bank.json"))).toBe(true);
      await run(false);
      expect(readdirSync(dir).sort()).toEqual(["_sandbox", "bank.json"]); // a regular run writes to the working one
    } finally {
      if (saved === undefined) delete process.env["FL0W_MEMORY_DIR"];
      else process.env["FL0W_MEMORY_DIR"] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nested run events", () => {
  const two = (ids: { callee: string }): [Flow, Flow] => {
    const callerFlow: Flow = { ...flow([node("m0", "manual"), node("p", "run_flow", { channelId: "ch", data: { v: 1 } }), node("r", "result")], [edge("m0", "p"), edge("p", "r")]), id: "A" };
    const calleeFlow = callee(ids.callee, "ch", [code("cc", "return { out0: { ok: 1 } }")]);
    return [callerFlow, calleeFlow];
  };
  const started = (r: { events: RunnerEvent[] }) => r.events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));

  it("the same flow: nodes of the called graph are visible in the feed (incoming and its chain are highlighted on the canvas)", async () => {
    const one: Flow = {
      ...flow([node("m0", "manual"), node("p", "run_flow", { channelId: "ch", data: { v: 1 } }), node("r", "result"), node("in", "call_trigger", { channelId: "ch" }), code("cc", "return { out0: 1 }"), node("r2", "result")], [edge("m0", "p"), edge("p", "r"), edge("in", "cc"), edge("cc", "r2")]),
      id: "A",
    };
    const r = await collect(one, { registry, resolveCall: resolverFor(one) });
    expect(r.done?.error).toBeUndefined();
    expect(started(r)).toEqual(expect.arrayContaining(["m0", "p", "in", "cc", "r2", "r"]));
    expect(ev(r.events, "flow:done")).toHaveLength(1); // one result; the inner one is not forwarded
  });

  it("another flow: events are not forwarded (node ids of two flows may coincide), only the result arrives", async () => {
    const [a, b] = two({ callee: "B" });
    const r = await collect(a, { registry, resolveCall: resolverFor(a, b) });
    expect(started(r)).toEqual(["m0", "p", "r"]);
    expect(r.done?.result).toEqual({ ok: 1 });
  });
});

describe("recursion cannot occur: Emitter/Loop and Collector are not in one graph", () => {
  const flowOf = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], id = "g"): Flow => ({ ...flow(nodes, edges), id });

  it("graphs are connected components (over all edges, including resource ones)", () => {
    const f = flowOf([node("a", "source"), node("b", "noop"), node("c", "source"), node("d", "noop")], [edge("a", "b"), edge("c", "d")]);
    const g = graphsOf(f);
    expect(g.get("a")).toBe(g.get("b"));
    expect(g.get("c")).toBe(g.get("d"));
    expect(g.get("a")).not.toBe(g.get("c"));
  });

  it("Emitter and Collector in one graph is a validation error, in different graphs of one flow it is allowed", () => {
    const same = flowOf(
      [node("in", "call_trigger", { channelId: "c" }), node("m", "noop"), node("p", "run_flow", { channelId: "c" }), node("r", "result")],
      [edge("in", "m"), edge("m", "p"), edge("p", "r")],
    );
    expect(validateCallGraph(same).map((i) => i.code)).toEqual(["call_same_graph"]);
    const v = validateFlow(same, registry);
    expect(!v.ok && v.issues.map((i) => i.code)).toContain("call_same_graph");
    // a different channel does not help: any outgoing + any incoming in one graph
    const otherChannel = flowOf([node("in", "call_trigger", { channelId: "a" }), node("p", "run_flow", { channelId: "b" })], [edge("in", "p")]);
    expect(validateCallGraph(otherChannel)).toHaveLength(1);
    // a graph connected through another block (Merge) is also one graph
    const viaMerge = flowOf(
      [node("m0", "manual"), node("in", "call_trigger", { channelId: "c" }), node("mg", "merge", { wait: "any" }), node("p", "run_flow", { channelId: "c" })],
      [edge("m0", "mg", "out0", "in0", "e0"), edge("in", "mg", "out0", "in1", "e1"), edge("mg", "p")],
    );
    expect(validateCallGraph(viaMerge)).toHaveLength(1);
    // separate graphs are fine
    const apart = flowOf([node("m0", "manual"), node("p", "run_flow", { channelId: "c" }), node("in", "call_trigger", { channelId: "c" }), node("r", "result")], [edge("m0", "p"), edge("in", "r")]);
    expect(validateCallGraph(apart)).toEqual([]);
  });

  it("consequence: a called graph calls no one itself, so there are no call chains or cycles (for repetition use Loop)", async () => {
    // attempt at a chain A → B → C: graph B with a Collector cannot contain an Emitter; the validator rejects such a B
    const b = flowOf([node("in", "call_trigger", { channelId: "ab" }), node("p", "run_flow", { channelId: "bc" })], [edge("in", "p")], "B");
    expect(validateFlow(b, registry).ok).toBe(false);
  });
});

describe("cancellation is not an error: aborted nodes of nested runs do not write node:error \"Aborted\"", () => {
  /** One flow, two unconnected graphs: Manual → Emitter(shoot); Collector → three parallel Waits → Result. The main graph ends at once. */
  const sameFlowShoot = (): Flow => ({
    ...flow(
      [
        node("m0", "manual"),
        node("p", "run_flow", { channelId: "c", mode: "shoot" }),
        node("r", "result"),
        node("in", "call_trigger", { channelId: "c" }),
        node("w1", "wait", { amount: 3, unit: "seconds" }),
        node("w2", "wait", { amount: 3, unit: "seconds" }),
        node("w3", "wait", { amount: 3, unit: "seconds" }),
        node("mg", "merge", { mode: "array" }),
        node("r2", "result"),
      ],
      [edge("m0", "p"), edge("p", "r"), edge("in", "w1"), edge("in", "w2", "out0", "in0", "e2"), edge("in", "w3", "out0", "in0", "e3"), edge("w1", "mg", "out0", "in0", "e4"), edge("w2", "mg", "out0", "in1", "e5"), edge("w3", "mg", "out0", "in2", "e6"), edge("mg", "r2")],
    ),
    id: "A",
  });

  it("a shoot call of the same flow is cut off at the end of the run: node:killed in the feed, and its Waits have no \"Aborted\" errors", async () => {
    const f = sameFlowShoot();
    const r = await collect(f, { registry, resolveCall: resolverFor(f) });
    expect(r.done?.error).toBeUndefined();
    expect(ev(r.events, "node:killed")).toHaveLength(1);
    const aborted = r.events.filter((e) => e.event === "node:error" && /Aborted/.test(e.error));
    expect(aborted).toEqual([]);
  });

  it("same when a neighbouring branch fails: aborted parallel Waits inside a loop body write no errors, except the failed node itself", async () => {
    const f: Flow = flow(
      [node("s", "source", { json: [1] }), node("l", "loop"), node("w1", "wait", { amount: 3, unit: "seconds" }), node("w2", "wait", { amount: 3, unit: "seconds" }), node("bad", "code", { code: "throw new Error('boom')" }), node("rb", "result"), node("rd", "result")],
      [edge("s", "l"), edge("l", "w1", "body", "in0", "e1"), edge("l", "w2", "body", "in0", "e2"), edge("l", "bad", "body", "in0", "e3"), edge("w1", "rb", "out0", "in0", "e4"), edge("l", "rd", "out0", "in0", "e5")],
    );
    const r = await collect(f, { registry });
    expect(r.done?.error).toMatch(/boom/);
    const errors = r.events.flatMap((e) => (e.event === "node:error" ? [e.nodeId] : []));
    // the node `bad` itself failed (and the loop after it), aborted parallel Waits write no errors
    expect(errors.filter((id) => id.startsWith("w"))).toEqual([]);
    expect(errors).toContain("bad");
  });
});

import { registry } from "@fl0w/blocks";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

const logs = (events: RunnerEvent[], id: string) => events.flatMap((e) => (e.event === "node:log" && e.nodeId === id ? [e.message] : []));
const ran = (events: RunnerEvent[], id: string) => logs(events, id).includes("ran");
const code = (id: string) => node(id, "code", { code: `log("ran"); return { out0: { by: "${id}", got: inputs.in0 } }` });
const run = (f: ReturnType<typeof flow>, opts: Record<string, unknown> = {}) => collect(f, { registry, ...opts });

/** Source → a → b → c → Result, each stage logs "ran" when it actually executes. */
const chain = (pins: Record<string, Record<string, Json>> = {}) => {
  const nodes = [node("s", "source", { json: { v: 1 } }), code("a"), code("b"), code("c"), node("r", "result")];
  for (const n of nodes) if (pins[n.id]) n.pinData = pins[n.id]!;
  return flow(nodes, [edge("s", "a"), edge("a", "b"), edge("b", "c"), edge("c", "r")]);
};

describe("pin data", () => {
  it("a pinned node is not executed and returns the pinned output; the others go as usual", async () => {
    const r = await run(chain({ b: { out0: { fake: true } } }));
    expect(ran(r.events, "a")).toBe(true);
    expect(ran(r.events, "b")).toBe(false);
    expect(logs(r.events, "b")).toEqual(["pinned data used (node not executed)"]);
    expect(ran(r.events, "c")).toBe(true);
    expect(r.done?.result).toEqual({ by: "c", got: { fake: true } });
  });

  it("a pinned output of a source node also replaces the data", async () => {
    const r = await run(chain({ s: { out0: { v: 99 } } }));
    expect(r.done?.result).toMatchObject({ by: "c", got: { by: "b", got: { by: "a", got: { v: 99 } } } });
  });

  it("scheduled runs (with trigger) ignore pins: a published flow works on real data", async () => {
    const f = flow(
      [{ ...node("w", "webhook", { path: "x" }), pinData: { out0: { fake: 1 } } }, node("r", "result")],
      [edge("w", "r")],
    );
    const r = await run(f, { trigger: "w", triggerData: { real: 1 } });
    expect(r.done?.result).toEqual({ real: 1 });
  });

  it("an event trigger with pinned data starts in a manual run; without a pin it does not", async () => {
    const mk = (pin?: Record<string, Json>) =>
      flow([{ ...node("w", "webhook", { path: "x" }), ...(pin ? { pinData: pin } : {}) }, node("r", "result")], [edge("w", "r")]);
    const pinned = await run(mk({ out0: { method: "POST", body: { id: 7 } } }));
    expect(pinned.started).toEqual(["w", "r"]);
    expect(pinned.done?.result).toEqual({ method: "POST", body: { id: 7 } });
    const bare = await run(mk());
    expect(bare.started).toEqual([]);
    expect(bare.done?.error).toMatch(/Nothing to start manually/);
  });

  it("a node with a pin is valid in the schema, extra data does not break the flow", async () => {
    const r = await run(chain({ a: { out0: { x: [1, 2, 3] }, extra: 1 } }));
    expect(r.done?.error).toBeUndefined();
  });
});

describe("restart from a node (from + seeds)", () => {
  const seeds = { s: { out0: { v: 1 } }, a: { out0: { by: "a-old" } } };

  it("the chosen node and everything after it is executed; predecessors supply data from the previous run", async () => {
    const r = await run(chain(), { from: "b", seeds });
    expect(ran(r.events, "a")).toBe(false);
    expect(logs(r.events, "a")).toEqual(["data from the previous run used (node not executed)"]);
    expect(ran(r.events, "b")).toBe(true);
    expect(ran(r.events, "c")).toBe(true);
    expect(r.done?.result).toMatchObject({ by: "c", got: { by: "b", got: { by: "a-old" } } });
    // source s is needed only by the predecessor, the frozen node a: it does not start and does not interfere
    expect(r.started).toContain("r");
  });

  it("a needed predecessor has no data: a clear error, nothing extra is started", async () => {
    const r = await run(chain(), { from: "b", seeds: { s: { out0: { v: 1 } } } });
    expect(r.done?.error).toMatch(/No saved data for node "a"/);
    expect(ran(r.events, "b")).toBe(false);
  });

  it("an unknown node is an error; restarting from the first node needs no seeds", async () => {
    expect((await run(chain(), { from: "zzz" })).done?.error).toMatch(/Unknown node "zzz"/);
    const r = await run(chain(), { from: "s" });
    expect(r.done?.error).toBeUndefined();
    expect(ran(r.events, "c")).toBe(true);
  });

  it("a pinned node in the restarted part uses the pin rather than being executed", async () => {
    const r = await run(chain({ c: { out0: { pinned: "c" } } }), { from: "a", seeds: { s: { out0: { v: 1 } } } });
    expect(ran(r.events, "a")).toBe(true);
    expect(ran(r.events, "c")).toBe(false);
    expect(r.done?.result).toEqual({ pinned: "c" });
  });

  it("branches unrelated to the restart point do not start", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), code("a"), code("other"), node("r", "result"), node("r2", "result")],
      [edge("s", "a"), edge("a", "r"), edge("s", "other"), edge("other", "r2")],
    );
    const r = await run(f, { from: "a", seeds: { s: { out0: { v: 1 } } } });
    expect(ran(r.events, "a")).toBe(true);
    expect(ran(r.events, "other")).toBe(false);
    expect(r.started).not.toContain("other");
  });

  it("from also works for flows with event triggers (trigger data comes from seeds)", async () => {
    const f = flow([node("w", "webhook", { path: "x" }), code("a"), node("r", "result")], [edge("w", "a"), edge("a", "r")]);
    const r = await run(f, { from: "a", seeds: { w: { out0: { body: { id: 1 } } } } });
    expect(r.done?.result).toEqual({ by: "a", got: { body: { id: 1 } } });
  });

  it("large seeds data is truncated in the event but goes along the edges in full", async () => {
    const big = "x".repeat(200_000);
    const r = await run(chain(), { from: "b", seeds: { s: { out0: { v: 1 } }, a: { out0: { big } } } });
    expect(JSON.stringify(r.done?.result)).toContain(big.slice(0, 1000));
    const done = r.events.find((e) => e.event === "node:done" && e.nodeId === "a");
    expect(JSON.stringify(done).length).toBeLessThan(60_000);
  });
});

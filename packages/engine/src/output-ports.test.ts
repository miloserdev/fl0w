import { registry } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

const run = (f: Flow) => collect(f, { registry });

describe("block outputs are checked against declared ports", () => {
  const codeFlow = (body: string, portsOverride: Flow["nodes"][number]["portsOverride"] = null): Flow =>
    flow(
      [node("s", "source", { json: { a: 1 } }), { ...node("c", "code", { code: body }), portsOverride }, node("r", "result")],
      [edge("s", "c"), edge("c", "r")],
    );

  it("a key outside the ports (typo, no portsOverride) is a node error listing the real ports, not a silent \"branch did not go\"", async () => {
    const r = await run(codeFlow("return { out9: inputs.in0 }"));
    expect(r.done?.error).toMatch(/Node "c" failed: The block returned data for port "out9" that does not exist \(output ports: out0\)/);
  });

  it("a port added via portsOverride is allowed; several extra keys are listed", async () => {
    const ok = codeFlow("return { out1: inputs.in0 }", { inputs: [], outputs: [{ id: "out1" }] });
    const f: Flow = { ...ok, edges: [edge("s", "c"), edge("c", "r", "out1", "in0", "e-out1")] };
    expect((await run(f)).done?.result).toEqual({ a: 1 });
    const many = await run(codeFlow("return { x: 1, y: 2, out0: 3 }"));
    expect(many.done?.error).toMatch(/ports "x", "y" that do not exist/);
  });

  it("service keys of Result (in0) and Respond to Webhook (response) are not counted as extra", async () => {
    const f = flow([node("s", "source", { json: { v: 1 } }), node("r", "result")], [edge("s", "r")]);
    expect((await run(f)).done?.error).toBeUndefined();
    const hook = flow([node("w", "webhook", { path: "x", method: "POST" }), node("rw", "respond_to_webhook", { status: 201 })], [edge("w", "rw")]);
    const events = (await collect(hook, { registry, trigger: "w", triggerData: { body: 1 } })).events;
    expect(events.some((e) => e.event === "node:error")).toBe(false);
    expect(events.find((e) => e.event === "node:done" && e.nodeId === "rw")).toMatchObject({ output: { response: { status: 201 } } });
  });

  it("ports that depend on parameters (Emitter err, Loop err) are taken into account", async () => {
    // Loop with onError: continue yields err: the port is declared via portsFor, no error
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("l", "loop", { onError: "continue" }), node("c", "code", { code: "throw new Error('x')" }), node("rd", "result"), node("re", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("l", "rd", "out0", "in0", "ed"), edge("l", "re", "err", "in0", "ee")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
  });
});

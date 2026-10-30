import { registry } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

const run = (f: Flow) => collect(f, { registry });

describe("выходы блока сверяются с объявленными портами", () => {
  const codeFlow = (body: string, portsOverride: Flow["nodes"][number]["portsOverride"] = null): Flow =>
    flow(
      [node("s", "source", { json: { a: 1 } }), { ...node("c", "code", { code: body }), portsOverride }, node("r", "result")],
      [edge("s", "c"), edge("c", "r")],
    );

  it("ключ вне портов (опечатка, нет portsOverride) — ошибка ноды с перечнем реальных портов, а не молчаливое «ветка не пошла»", async () => {
    const r = await run(codeFlow("return { out9: inputs.in0 }"));
    expect(r.done?.error).toMatch(/Node "c" failed: The block returned data for port "out9" that does not exist \(output ports: out0\)/);
  });

  it("порт, добавленный через portsOverride, допустим; несколько лишних ключей перечисляются", async () => {
    const ok = codeFlow("return { out1: inputs.in0 }", { inputs: [], outputs: [{ id: "out1" }] });
    const f: Flow = { ...ok, edges: [edge("s", "c"), edge("c", "r", "out1", "in0", "e-out1")] };
    expect((await run(f)).done?.result).toEqual({ a: 1 });
    const many = await run(codeFlow("return { x: 1, y: 2, out0: 3 }"));
    expect(many.done?.error).toMatch(/ports "x", "y" that do not exist/);
  });

  it("служебные ключи Result (in0) и Respond to Webhook (response) не считаются лишними", async () => {
    const f = flow([node("s", "source", { json: { v: 1 } }), node("r", "result")], [edge("s", "r")]);
    expect((await run(f)).done?.error).toBeUndefined();
    const hook = flow([node("w", "webhook", { path: "x", method: "POST" }), node("rw", "respond_to_webhook", { status: 201 })], [edge("w", "rw")]);
    const events = (await collect(hook, { registry, trigger: "w", triggerData: { body: 1 } })).events;
    expect(events.some((e) => e.event === "node:error")).toBe(false);
    expect(events.find((e) => e.event === "node:done" && e.nodeId === "rw")).toMatchObject({ output: { response: { status: 201 } } });
  });

  it("порты, зависящие от параметров (Emitter err, Loop err), учитываются", async () => {
    // Loop с onError: continue отдаёт err — порт объявлен через portsFor, ошибки нет
    const f: Flow = flow(
      [node("s", "source", { json: [1, 2] }), node("l", "loop", { onError: "continue" }), node("c", "code", { code: "throw new Error('x')" }), node("rd", "result"), node("re", "result")],
      [edge("s", "l"), edge("l", "c", "body", "in0", "eb"), edge("l", "rd", "out0", "in0", "ed"), edge("l", "re", "err", "in0", "ee")],
    );
    const r = await run(f);
    expect(r.done?.error).toBeUndefined();
  });
});

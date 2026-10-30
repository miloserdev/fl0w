import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registry } from "@fl0w/blocks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

let dir: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["FL0W_MEMORY_DIR"];
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-cnt-"));
  process.env["FL0W_MEMORY_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["FL0W_MEMORY_DIR"];
  else process.env["FL0W_MEMORY_DIR"] = saved;
  rmSync(dir, { recursive: true, force: true });
});

const f = (id = "flow_cnt", params = {}) => ({
  ...flow([node("s", "source", { json: { a: 1 } }), node("c", "counter", params), node("r", "result")], [edge("s", "c"), edge("c", "r")]),
  id,
});
const shown = async (fl: ReturnType<typeof f>) => {
  const r = await collect(fl, { registry });
  const done = r.events.find((e) => e.event === "node:done" && e.nodeId === "c");
  return { display: done?.event === "node:done" ? done.display : undefined, result: r.done?.result };
};

describe("Counter в запуске флоу", () => {
  it("node:done несёт display с числом срабатываний; данные идут дальше нетронутыми", async () => {
    expect(await shown(f())).toEqual({ display: "1", result: { a: 1 } });
    expect((await shown(f())).display).toBe("2");
    expect((await shown(f())).display).toBe("3");
  });

  it("счёт принадлежит флоу и ноде: другой флоу и другая нода считают отдельно", async () => {
    expect((await shown(f("flow_other"))).display).toBe("1");
    const renamed = f();
    renamed.nodes[1]!.id = "c2";
    renamed.edges = [edge("s", "c2"), edge("c2", "r")];
    const r = await collect(renamed, { registry });
    expect(r.events.some((e) => e.event === "node:done" && e.nodeId === "c2" && e.display === "1")).toBe(true);
  });

  it("закреплённая (pin) нода не исполняется и не считает; reset обнуляет", async () => {
    const pinned = f();
    pinned.nodes[1] = { ...pinned.nodes[1]!, pinData: { out0: { fake: true } } };
    expect((await shown(pinned)).display).toBeUndefined();
    expect((await shown(f())).display).toBe("4");
    expect((await shown(f("flow_cnt", { operation: "reset" }))).display).toBe("0");
    expect((await shown(f())).display).toBe("1");
  });
});

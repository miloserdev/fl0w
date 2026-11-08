import { registry } from "@fl0w/blocks";
import type { Flow } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

/** Two unconnected graphs, each with its own Manual: m1 → c1 → r1 and m2 → c2 → r2. */
const two = (pin?: Record<string, unknown>): Flow => {
  const f = flow(
    [node("m1", "manual"), node("c1", "code", { code: "return { out0: 'one' }" }), node("r1", "result"), node("m2", "manual"), node("c2", "code", { code: "return { out0: 'two' }" }), node("r2", "result")],
    [edge("m1", "c1"), edge("c1", "r1"), edge("m2", "c2"), edge("c2", "r2")],
  );
  if (pin) f.nodes = f.nodes.map((n) => (n.id === "c1" ? { ...n, pinData: pin as never } : n));
  return f;
};

describe("running a single trigger (button on Manual)", () => {
  it("without a choice both Manuals start; with trigger only the chosen one, the others stay silent", async () => {
    const both = await collect(two(), { registry });
    expect(both.started.sort()).toEqual(["c1", "c2", "m1", "m2", "r1", "r2"]);
    const one = await collect(two(), { registry, trigger: "m1" });
    expect(one.done?.error).toBeUndefined();
    expect(one.started).toEqual(["m1", "c1", "r1"]);
    expect(one.done?.result).toBe("one");
    const other = await collect(two(), { registry, trigger: "m2" });
    expect(other.started).toEqual(["m2", "c2", "r2"]);
    expect(other.done?.result).toBe("two");
  });

  it("pins: with trigger and without pins they have no effect (scheduled runs go this way), with pins: true they do (sandbox)", async () => {
    const pinned = two({ out0: "PINNED" });
    expect((await collect(pinned, { registry, trigger: "m1" })).done?.result).toBe("one");
    const sandbox = await collect(pinned, { registry, trigger: "m1", pins: true });
    expect(sandbox.done?.result).toBe("PINNED");
    expect(sandbox.started).toContain("c1"); // the node is pinned: it "starts" with the pin data, but its code is not executed
  });

  it("an unknown or non-trigger id is a clear error", async () => {
    expect((await collect(two(), { registry, trigger: "zzz" })).done?.error).toMatch(/Unknown trigger "zzz"/);
    expect((await collect(two(), { registry, trigger: "c1" })).done?.error).toMatch(/Unknown trigger "c1"/);
  });

  it("Manual has a run button (manualStart), other triggers do not", () => {
    expect(registry["manual"]!.manualStart).toBe(true);
    for (const [type, cls] of Object.entries(registry)) if (type !== "manual") expect(cls.manualStart, type).toBe(false);
  });
});

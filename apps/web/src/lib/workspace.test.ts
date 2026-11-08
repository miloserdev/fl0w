import { describe, expect, it } from "vitest";
import type { Flow } from "@fl0w/schema";
import { closeTab, flowKey, LEGACY_FLOW_KEY, loadTabs, moveActive, nextName, openTab, otherFlows, readFlow, renameTab, saveTabs, TABS_KEY, writeFlow } from "./workspace";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const flow = (id: string, name = id, nodes = 1): Flow => ({
  version: 1,
  id,
  name,
  nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, type: "manual", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null })),
  edges: [],
});
const tab = (id: string, name = id) => ({ id, name });

describe("tabs", () => {
  it("nextName: the first free name", () => {
    expect(nextName([])).toBe("flow");
    expect(nextName([tab("a", "flow")])).toBe("flow 2");
    expect(nextName([tab("a", "flow"), tab("b", "flow 2"), tab("c", "other")])).toBe("flow 3");
  });

  it("openTab: a new tab is activated, an open one is only activated without a duplicate", () => {
    const s = { tabs: [tab("a")], active: "a" };
    expect(openTab(s, tab("b"))).toEqual({ tabs: [tab("a"), tab("b")], active: "b" });
    expect(openTab({ tabs: [tab("a"), tab("b")], active: "b" }, tab("a"))).toEqual({ tabs: [tab("a"), tab("b")], active: "a" });
  });

  it("closeTab: the neighbouring one becomes active; the last one is replaced by a new one; closing another tab does not touch the active one", () => {
    const s = { tabs: [tab("a"), tab("b"), tab("c")], active: "b" };
    expect(closeTab(s, "b", tab("x")).active).toBe("c");
    expect(closeTab({ ...s, active: "c" }, "c", tab("x")).active).toBe("b");
    expect(closeTab(s, "a", tab("x"))).toEqual({ tabs: [tab("b"), tab("c")], active: "b" });
    expect(closeTab({ tabs: [tab("a")], active: "a" }, "a", tab("x"))).toEqual({ tabs: [tab("x")], active: "x" });
    expect(closeTab(s, "nope", tab("x"))).toBe(s);
  });

  it("renameTab / moveActive: an empty name and calls that change nothing return the same state", () => {
    const s = { tabs: [tab("a", "one")], active: "a" };
    expect(renameTab(s, "a", "  two ").tabs[0]!.name).toBe("two");
    expect(renameTab(s, "a", "   ")).toBe(s);
    expect(renameTab(s, "a", "one")).toBe(s);
    expect(moveActive(s, "a")).toBe(s);
    expect(moveActive(s, "zzz")).toBe(s);
  });
});

describe("storage", () => {
  it("loadTabs: empty — one new tab", () => {
    expect(loadTabs(mem(), () => tab("n1", "flow"))).toEqual({ tabs: [tab("n1", "flow")], active: "n1" });
  });

  it("loadTabs: saved tabs are restored; a wrong active and garbage are dropped", () => {
    const s = mem();
    saveTabs(s, { tabs: [tab("a"), tab("b")], active: "zzz" });
    expect(loadTabs(s, () => tab("n"))).toEqual({ tabs: [tab("a"), tab("b")], active: "a" });
    s.setItem(TABS_KEY, JSON.stringify({ tabs: [{ id: "../evil", name: "x" }, { id: 5 }], active: "a" }));
    expect(loadTabs(s, () => tab("n")).tabs).toEqual([tab("n")]);
    s.setItem(TABS_KEY, "{broken");
    expect(loadTabs(s, () => tab("n")).tabs).toEqual([tab("n")]);
  });

  it("loadTabs: the old version's flow moves into the first tab", () => {
    const s = mem();
    s.setItem(LEGACY_FLOW_KEY, JSON.stringify(flow("old", "Мой флоу", 2)));
    const st = loadTabs(s, () => tab("n"));
    expect(st).toEqual({ tabs: [tab("old", "Мой флоу")], active: "old" });
    expect(readFlow(s, "old")?.nodes).toHaveLength(2);
    expect(s.getItem(LEGACY_FLOW_KEY)).toBeNull();
  });

  it("readFlow/writeFlow: broken and foreign format — null", () => {
    const s = mem();
    writeFlow(s, flow("a"));
    expect(readFlow(s, "a")?.id).toBe("a");
    s.setItem(flowKey("b"), "{nope");
    expect(readFlow(s, "b")).toBeNull();
    s.setItem(flowKey("c"), JSON.stringify({ hello: 1 }));
    expect(readFlow(s, "c")).toBeNull();
  });

  it("otherFlows: flows of the other tabs, without the current one, empty and broken ones", () => {
    const s = mem();
    writeFlow(s, flow("a"));
    writeFlow(s, flow("b"));
    writeFlow(s, flow("empty", "empty", 0));
    s.setItem(flowKey("bad"), "{");
    const ids = otherFlows(s, [tab("a"), tab("b"), tab("empty"), tab("bad"), tab("gone")], "a").map((f) => f.id);
    expect(ids).toEqual(["b"]);
  });
});

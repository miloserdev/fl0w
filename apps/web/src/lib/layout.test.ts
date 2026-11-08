import { describe, expect, it } from "vitest";
import { layoutNodeProps, layoutPalette, layoutSize, nodesInsideGroup, type Box } from "./layout";

const group: Box = { id: "g", x: 100, y: 100, width: 400, height: 200 };
const box = (id: string, x: number, y: number, width = 64, height = 64): Box => ({ id, x, y, width, height });

describe("nodesInsideGroup", () => {
  it("takes nodes whose centre is inside the frame", () => {
    expect(nodesInsideGroup(group, [box("a", 150, 150), box("b", 600, 150)])).toEqual(["a"]);
  });
  it("a node only partly crossing the frame but with its centre inside is included; with the centre outside — not", () => {
    expect(nodesInsideGroup(group, [box("in", 460, 150), box("out", 470, 150)])).toEqual(["in"]);
  });
  it("borders are included, the group itself is not", () => {
    expect(nodesInsideGroup(group, [group, box("edge", 100 - 32, 100 - 32)])).toEqual(["edge"]);
  });
  it("accounts for node size (centre, not the top-left corner)", () => {
    // corner inside, centre outside
    expect(nodesInsideGroup(group, [box("big", 450, 150, 300, 64)])).toEqual([]);
  });
  it("empty list", () => {
    expect(nodesInsideGroup(group, [])).toEqual([]);
  });
});

describe("layoutSize / layoutNodeProps", () => {
  it("takes size from params, clamped by the schema", () => {
    expect(layoutSize("note", { width: 300, height: 100 })).toEqual({ width: 300, height: 100 });
    expect(layoutSize("note", { width: 10, height: 99999 })).toEqual({ width: 80, height: 4000 });
  });
  it("without values — the class's default size", () => {
    expect(layoutSize("group", {})).toEqual({ width: 420, height: 260 });
    expect(layoutSize("note", { width: "x" })).toEqual({ width: 220, height: 140 });
  });
  it("a group lies under the others, an ordinary block is untouched", () => {
    // layers: group < note < blocks (0): neither a note nor a group covers nodes
    const group = layoutNodeProps("group", {}).zIndex!;
    const note = layoutNodeProps("note", {}).zIndex!;
    expect(group).toBeLessThan(note);
    expect(note).toBeLessThan(0);
    expect(layoutNodeProps("source", {}).zIndex).toBeUndefined();
    expect(layoutNodeProps("log", {}).zIndex).toBeUndefined(); // Log is an ordinary node, not decoration
    expect(layoutNodeProps("noop", {})).toEqual({});
  });
  it("unknown colour — grey", () => {
    expect(layoutPalette("nope")).toBe(layoutPalette("gray"));
  });
});

describe("Log as a resizable block", () => {
  it("is drawn as a terminal, its size is limited by its parameter schema (not by note bounds) and it is not considered decoration", async () => {
    const { nodeTypeFor } = await import("./flow-convert");
    const { isLayoutBlock, isResizableBlock, layoutSize } = await import("./layout");
    expect(nodeTypeFor("log")).toBe("terminal");
    expect(isResizableBlock("log")).toBe(true);
    expect(isLayoutBlock("log")).toBe(false); // takes part in the run, unlike notes and groups
    expect(layoutSize("log", { width: 10, height: 10 })).toEqual({ width: 160, height: 80 });
    expect(layoutSize("log", {})).toEqual({ width: 360, height: 160 });
    expect(layoutSize("note", { width: 100, height: 70 })).toEqual({ width: 100, height: 70 });
    expect(isResizableBlock("counter")).toBe(false);
  });
});

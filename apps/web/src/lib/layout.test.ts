import { describe, expect, it } from "vitest";
import { layoutNodeProps, layoutPalette, layoutSize, nodesInsideGroup, type Box } from "./layout";

const group: Box = { id: "g", x: 100, y: 100, width: 400, height: 200 };
const box = (id: string, x: number, y: number, width = 64, height = 64): Box => ({ id, x, y, width, height });

describe("nodesInsideGroup", () => {
  it("берёт ноды, чей центр внутри рамки", () => {
    expect(nodesInsideGroup(group, [box("a", 150, 150), box("b", 600, 150)])).toEqual(["a"]);
  });
  it("нода, лишь частично заходящая за рамку, но с центром внутри, входит; с центром снаружи — нет", () => {
    expect(nodesInsideGroup(group, [box("in", 460, 150), box("out", 470, 150)])).toEqual(["in"]);
  });
  it("границы включены, сама группа не входит", () => {
    expect(nodesInsideGroup(group, [group, box("edge", 100 - 32, 100 - 32)])).toEqual(["edge"]);
  });
  it("учитывает размер ноды (центр, а не левый верхний угол)", () => {
    // угол внутри, центр за пределами
    expect(nodesInsideGroup(group, [box("big", 450, 150, 300, 64)])).toEqual([]);
  });
  it("пустой список", () => {
    expect(nodesInsideGroup(group, [])).toEqual([]);
  });
});

describe("layoutSize / layoutNodeProps", () => {
  it("берёт размер из params, ограничивая схемой", () => {
    expect(layoutSize("note", { width: 300, height: 100 })).toEqual({ width: 300, height: 100 });
    expect(layoutSize("note", { width: 10, height: 99999 })).toEqual({ width: 80, height: 4000 });
  });
  it("без значений — размер по умолчанию класса", () => {
    expect(layoutSize("group", {})).toEqual({ width: 420, height: 260 });
    expect(layoutSize("note", { width: "x" })).toEqual({ width: 220, height: 140 });
  });
  it("группа лежит под остальными, обычный блок не затронут", () => {
    expect(layoutNodeProps("group", {}).zIndex).toBeLessThan(0);
    expect(layoutNodeProps("note", {}).zIndex).toBeUndefined();
    expect(layoutNodeProps("noop", {})).toEqual({});
  });
  it("неизвестный цвет — серый", () => {
    expect(layoutPalette("nope")).toBe(layoutPalette("gray"));
  });
});

describe("Log как изменяемый по размеру блок", () => {
  it("рисуется терминалом, размер ограничен схемой его параметров (не заметочными границами) и не считается оформлением", async () => {
    const { nodeTypeFor } = await import("./flow-convert");
    const { isLayoutBlock, isResizableBlock, layoutSize } = await import("./layout");
    expect(nodeTypeFor("log")).toBe("terminal");
    expect(isResizableBlock("log")).toBe(true);
    expect(isLayoutBlock("log")).toBe(false); // участвует в запуске, в отличие от заметок и групп
    expect(layoutSize("log", { width: 10, height: 10 })).toEqual({ width: 160, height: 80 });
    expect(layoutSize("log", {})).toEqual({ width: 360, height: 160 });
    expect(layoutSize("note", { width: 100, height: 70 })).toEqual({ width: 100, height: 70 });
    expect(isResizableBlock("counter")).toBe(false);
  });
});

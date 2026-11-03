import { describe, expect, it } from "vitest";
import type { Flow } from "@fl0w/schema";
import { toReactFlow } from "./flow-convert";
import { History, sameDoc } from "./history";

const base: Flow = {
  version: 1,
  id: "f",
  name: "f",
  nodes: [
    { id: "a", type: "manual", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null },
    { id: "b", type: "result", position: { x: 100, y: 0 }, params: {}, portsOverride: null, cssOverride: null },
  ],
  edges: [],
};
const doc = () => toReactFlow(base);
const moved = (d: ReturnType<typeof doc>, x: number) => ({ nodes: d.nodes.map((n, i) => (i === 0 ? { ...n, position: { x, y: 0 } } : n)), edges: d.edges });

describe("sameDoc", () => {
  it("выделение и размеры не меняют документ; положение и параметры — меняют", () => {
    const d = doc();
    expect(sameDoc(d, { nodes: d.nodes.map((n) => ({ ...n, selected: true, width: 9 })), edges: d.edges })).toBe(true);
    expect(sameDoc(d, moved(d, 5))).toBe(false);
    expect(sameDoc(d, { nodes: d.nodes.map((n, i) => (i === 1 ? { ...n, data: { ...n.data, disabled: true } } : n)), edges: d.edges })).toBe(false);
  });
});

describe("History", () => {
  it("undo/redo по правкам; новая правка сбрасывает redo; одинаковый документ не пишется", () => {
    const h = new History();
    const d0 = doc();
    h.reset(d0);
    expect(h.commit(d0)).toBe(false);
    const d1 = moved(d0, 10);
    const d2 = moved(d0, 20);
    expect(h.commit(d1)).toBe(true);
    expect(h.commit(d2)).toBe(true);
    expect(h.undo()!.nodes[0]!.position.x).toBe(10);
    expect(h.undo()!.nodes[0]!.position.x).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()!.nodes[0]!.position.x).toBe(10);
    expect(h.commit(moved(d0, 99))).toBe(true); // новая ветка
    expect(h.canRedo).toBe(false);
    expect(h.undo()!.nodes[0]!.position.x).toBe(10);
  });

  it("глубина ограничена; в снимках нет выделения", () => {
    const h = new History(3);
    const d0 = doc();
    h.reset({ nodes: d0.nodes.map((n) => ({ ...n, selected: true })), edges: [] });
    for (let i = 1; i <= 6; i++) h.commit(moved(d0, i));
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(3);
    const back = new History();
    back.reset({ nodes: d0.nodes.map((n) => ({ ...n, selected: true })), edges: [] });
    back.commit(moved(d0, 1));
    expect(back.undo()!.nodes.every((n) => !n.selected)).toBe(true);
  });
});

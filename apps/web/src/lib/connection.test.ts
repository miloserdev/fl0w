import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { canConnect } from "./connection";

const n = (id: string, blockType: string) => ({ id, data: { blockType, params: {}, portsOverride: null, cssOverride: null } });
const nodes = [n("a", "code_agent"), n("t1", "tool_calculator"), n("t2", "tool_datetime"), n("m", "memory_bank"), n("s", "source"), n("r", "result")];
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge => ({
  id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle,
});

describe("canConnect", () => {
  it("инструмент -> порт tools, много рёбер", () => {
    const es = [edge("t1", "tool", "a", "tools")];
    expect(canConnect(nodes, es, { source: "t2", sourceHandle: "tool", target: "a", targetHandle: "tools" })).toBe(true);
  });
  it("повтор того же ребра запрещён", () => {
    const es = [edge("t1", "tool", "a", "tools")];
    expect(canConnect(nodes, es, { source: "t1", sourceHandle: "tool", target: "a", targetHandle: "tools" })).toBe(false);
  });
  it("разные виды не соединяются", () => {
    expect(canConnect(nodes, [], { source: "t1", sourceHandle: "tool", target: "a", targetHandle: "memory" })).toBe(false);
    expect(canConnect(nodes, [], { source: "m", sourceHandle: "memory", target: "a", targetHandle: "tools" })).toBe(false);
    expect(canConnect(nodes, [], { source: "t1", sourceHandle: "tool", target: "a", targetHandle: "in0" })).toBe(false);
    expect(canConnect(nodes, [], { source: "s", sourceHandle: "out0", target: "a", targetHandle: "tools" })).toBe(false);
  });
  it("порт данных без multiple принимает одно ребро", () => {
    const es = [edge("s", "out0", "a", "in0")];
    expect(canConnect(nodes, es, { source: "s", sourceHandle: "out0", target: "r", targetHandle: "in0" })).toBe(true);
    expect(canConnect(nodes, [edge("s", "out0", "r", "in0")], { source: "a", sourceHandle: "out0", target: "r", targetHandle: "in0" })).toBe(false);
  });
  it("циклы данных запрещены", () => {
    const es = [edge("s", "out0", "a", "in0"), edge("a", "out0", "r", "in0")];
    expect(canConnect(nodes, es, { source: "a", sourceHandle: "out0", target: "s", targetHandle: "in0" })).toBe(false);
  });
  it("неизвестные порты и ноды", () => {
    expect(canConnect(nodes, [], { source: "t1", sourceHandle: "x", target: "a", targetHandle: "tools" })).toBe(false);
    expect(canConnect(nodes, [], { source: "zz", sourceHandle: "tool", target: "a", targetHandle: "tools" })).toBe(false);
    expect(canConnect(nodes, [], { source: "a", sourceHandle: "out0", target: "a", targetHandle: "in0" })).toBe(false);
  });
});

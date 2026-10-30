import { describe, expect, it } from "vitest";
import { collectSeeds, edgeClassFor, flowFingerprint, fromReactFlow, nodePortKind, parsePin, splitPorts, toReactFlow } from "./flow-convert";
import type { Flow } from "@fl0w/schema";

describe("splitPorts", () => {
  it("делит порты на данные и ресурсные", () => {
    const r = splitPorts({
      inputs: [{ id: "in0" }, { id: "tools", kind: "tool", multiple: true }, { id: "memory", kind: "memory" }],
      outputs: [{ id: "out0", kind: "data" }, { id: "tool", kind: "tool" }],
    });
    expect(r.dataIn.map((p) => p.id)).toEqual(["in0"]);
    expect(r.resourceIn.map((p) => p.id)).toEqual(["tools", "memory"]);
    expect(r.dataOut.map((p) => p.id)).toEqual(["out0"]);
    expect(r.resourceOut.map((p) => p.id)).toEqual(["tool"]);
  });
});

describe("nodePortKind / edgeClassFor", () => {
  it("определяет вид порта у реального блока", () => {
    expect(nodePortKind("code_agent", null, "inputs", "tools")).toBe("tool");
    expect(nodePortKind("code_agent", null, "inputs", "in0")).toBe("data");
    expect(nodePortKind("code_agent", null, "inputs", "nope")).toBeNull();
    expect(nodePortKind("no_such_block", null, "inputs", "in0")).toBeNull();
  });
  it("пунктир только у ресурсных", () => {
    expect(edgeClassFor("data")).toBeUndefined();
    expect(edgeClassFor(null)).toBeUndefined();
    expect(edgeClassFor("memory")).toContain("fl-edge-resource");
  });
});

describe("toReactFlow", () => {
  it("проставляет className ресурсным рёбрам", () => {
    const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null });
    const flow = {
      version: 1,
      id: "f",
      name: "f",
      nodes: [node("a", "code_agent"), node("t", "tool_calculator"), node("m", "memory_bank"), node("s", "source")],
      edges: [
        { id: "e1", source: "s", sourcePort: "out0", target: "a", targetPort: "in0" },
        { id: "e2", source: "t", sourcePort: "tool", target: "a", targetPort: "tools" },
        { id: "e3", source: "m", sourcePort: "memory", target: "a", targetPort: "memory" },
      ],
    } as unknown as Flow;
    const { edges } = toReactFlow(flow);
    expect(edges[0]!.className).toBeUndefined();
    expect(edges[1]!.className).toContain("fl-edge-tool");
    expect(edges[2]!.className).toContain("fl-edge-memory");
  });
});

describe("pin data и перезапуск", () => {
  it("pinData проходит через Flow ↔ React Flow без потерь; без закрепления поле не пишется", () => {
    const flow = {
      version: 1 as const,
      id: "f",
      name: "n",
      nodes: [
        { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null, pinData: { out0: { x: 1 } } },
        { id: "b", type: "result", position: { x: 1, y: 1 }, params: {}, portsOverride: null, cssOverride: null },
      ],
      edges: [],
    };
    const rf = toReactFlow(flow);
    expect(rf.nodes[0]!.data.pinData).toEqual({ out0: { x: 1 } });
    const back = fromReactFlow(rf.nodes, rf.edges, { id: "f", name: "n" });
    expect(back.nodes[0]).toMatchObject({ pinData: { out0: { x: 1 } } });
    expect(back.nodes[1]).not.toHaveProperty("pinData");
  });

  it("закрепление не делает опубликованный флоу «изменённым»", () => {
    const base = { version: 1 as const, id: "f", name: "n", edges: [] };
    const node = { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null };
    expect(flowFingerprint({ ...base, nodes: [node] })).toBe(flowFingerprint({ ...base, nodes: [{ ...node, pinData: { out0: 1 } }] }));
  });

  it("collectSeeds берёт только выходы; parsePin требует объект", () => {
    expect(collectSeeds({ a: { output: { out0: 1 } }, b: {}, c: { output: {} } })).toEqual({ a: { out0: 1 }, c: {} });
    expect(parsePin('{"out0": {"a": 1}}')).toEqual({ ok: true, value: { out0: { a: 1 } } });
    for (const bad of ["[1]", "5", "null", "{oops", ""]) expect(parsePin(bad).ok, bad).toBe(false);
  });
});

describe("блоки оформления", () => {
  const mk = (type: string, params: Record<string, number | string>) => ({
    version: 1 as const,
    id: "f",
    name: "f",
    nodes: [{ id: "n1", type, position: { x: 10, y: 20 }, params, portsOverride: null, cssOverride: null }],
    edges: [],
  });

  it("размер из params попадает в ноду и возвращается обратно после растяжения", () => {
    const rf = toReactFlow(mk("note", { text: "hi", color: "pink", width: 300, height: 100 }));
    const node = rf.nodes[0]!;
    expect(node.type).toBe("layout-note");
    expect([node.width, node.height]).toEqual([300, 100]);
    // пользователь растянул ноду
    const back = fromReactFlow([{ ...node, width: 410.4, height: 222 }], [], { id: "f", name: "f" });
    expect(back.nodes[0]!.params).toEqual({ text: "hi", color: "pink", width: 410, height: 222 });
  });
  it("группа и заметка получают отрицательный zIndex (под блоками) и свой тип; у блока размера в params не появляется", () => {
    expect(toReactFlow(mk("group", { title: "A" })).nodes[0]).toMatchObject({ type: "layout-group", zIndex: -2, width: 420, height: 260 });
    expect(toReactFlow(mk("note", { text: "t" })).nodes[0]).toMatchObject({ type: "layout-note", zIndex: -1, width: 220, height: 140 });
    const block = toReactFlow(mk("noop", {})).nodes[0]!;
    expect(block.type).toBe("block");
    expect(fromReactFlow([block], [], { id: "f", name: "f" }).nodes[0]!.params).toEqual({});
  });
});

describe("отпечаток флоу и оформление", () => {
  it("правка заметки или группы не меняет отпечаток, правка блока — меняет", () => {
    const base = { version: 1 as const, id: "f", name: "n", edges: [] };
    const block = { id: "a", type: "source", position: { x: 0, y: 0 }, params: {}, portsOverride: null, cssOverride: null };
    const note = { id: "n1", type: "note", position: { x: 0, y: 0 }, params: { text: "a", width: 220, height: 140 }, portsOverride: null, cssOverride: null };
    const one = flowFingerprint({ ...base, nodes: [block, note] });
    expect(flowFingerprint({ ...base, nodes: [block, { ...note, params: { text: "b", width: 300, height: 200 } }] })).toBe(one);
    expect(flowFingerprint({ ...base, nodes: [block] })).toBe(one);
    expect(flowFingerprint({ ...base, nodes: [{ ...block, params: { json: 1 } }, note] })).not.toBe(one);
  });
});

describe("порты, зависящие от параметров (outgoing call)", () => {
  it("порт err есть только в режиме await; вид порта и класс ребра учитывают параметры", async () => {
    const { getPorts, nodePortKind } = await import("./flow-convert");
    const ids = (params: Record<string, unknown>) => getPorts("run_flow", null, params as never).outputs.map((p) => p.id);
    expect(ids({})).toEqual(["out0", "err"]); // по умолчанию await
    expect(ids({ mode: "await" })).toEqual(["out0", "err"]);
    expect(ids({ mode: "shoot" })).toEqual(["out0"]);
    expect(nodePortKind("run_flow", null, "outputs", "err", { mode: "await" })).toBe("data");
    expect(nodePortKind("run_flow", null, "outputs", "err", { mode: "shoot" })).toBeNull();
  });
});

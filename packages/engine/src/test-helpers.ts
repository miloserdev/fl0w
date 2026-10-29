import { Block, registry as base, type BlockClass, type RunContext } from "@fl0w/blocks";
import type { Flow, Json, ParamSchema, RunnerEvent } from "@fl0w/schema";

/** Тестовые блоки: нужны, чтобы проверять движок независимо от набора MVP-блоков. */
class Transform extends Block {
  static type = "transform";
  static label = "Transform";
  static icon = "box";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "mode", type: "enum", options: [{ value: "tag" }, { value: "double" }], default: "tag" },
  ];
  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    const v = inputs["in0"];
    ctx.log(`transform:${String(params["mode"])}`);
    if (params["mode"] === "double") return { out0: (v as number) * 2 };
    return { out0: { ...(v as object), tagged: true } };
  }
}

/** value > 0 → out0, иначе out1; второй порт остаётся пустым. */
class Branch extends Block {
  static type = "branch";
  static label = "Branch";
  static icon = "box";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }, { id: "out1" }] };
  static params: ParamSchema[] = [];
  async run(inputs: Record<string, Json>): Promise<Record<string, Json>> {
    return (inputs["in0"] as number) > 0 ? { out0: inputs["in0"]! } : { out1: inputs["in0"]! };
  }
}

class Join extends Block {
  static type = "join";
  static label = "Join";
  static icon = "box";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }, { id: "in1" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];
  static calls = 0;
  async run(inputs: Record<string, Json>) {
    Join.calls++;
    return { out0: { a: inputs["in0"]!, b: inputs["in1"]! } };
  }
}

class Boom extends Block {
  static type = "boom";
  static label = "Boom";
  static icon = "box";
  static category = "test";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];
  async run(): Promise<Record<string, Json>> {
    throw new Error("kaboom");
  }
}

class BadOutput extends Block {
  static type = "bad";
  static label = "Bad";
  static icon = "box";
  static category = "test";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];
  async run() {
    return { out0: (() => 1) as unknown as Json };
  }
}

class Slow extends Block {
  static type = "slow";
  static label = "Slow";
  static icon = "box";
  static category = "test";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];
  async run(_i: Record<string, Json>, _p: Record<string, Json>, ctx: RunContext) {
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
    return { out0: 1 };
  }
}

/** Пишет много логов и «хвост» уже после завершения ноды. */
class Chatty extends Block {
  static type = "chatty";
  static label = "Chatty";
  static icon = "box";
  static category = "test";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [{ name: "count", type: "number", default: 3 }];
  async run(_i: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    for (let i = 0; i < Number(params["count"]); i++) ctx.log(`line ${i}`);
    setTimeout(() => ctx.log("late"), 20);
    return { out0: 1 };
  }
}

/** Фиксирует момент, когда блок реально начал выполняться. */
class Probe extends Block {
  static type = "probe";
  static label = "Probe";
  static icon = "box";
  static category = "test";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];
  static trace: string[] = [];
  async run() {
    Probe.trace.push("block:run");
    return { out0: 1 };
  }
}

export { Join, Probe };

export const testRegistry: Record<string, BlockClass> = {
  ...base,
  transform: Transform,
  branch: Branch,
  join: Join,
  boom: Boom,
  bad: BadOutput,
  slow: Slow,
  chatty: Chatty,
  probe: Probe,
};

export function node(id: string, type: string, params: Record<string, Json> = {}): Flow["nodes"][number] {
  return { id, type, position: { x: 0, y: 0 }, params, portsOverride: null, cssOverride: null };
}

export function edge(
  source: string,
  target: string,
  sourcePort = "out0",
  targetPort = "in0",
  id = `${source}.${sourcePort}->${target}.${targetPort}`,
): Flow["edges"][number] {
  return { id, source, sourcePort, target, targetPort };
}

export function flow(nodes: Flow["nodes"], edges: Flow["edges"]): Flow {
  return { version: 1, id: "flow_test", name: "test", nodes, edges };
}

export async function collect(f: unknown, opts?: Parameters<typeof import("./run").runFlow>[2]) {
  const { runFlow } = await import("./run");
  const events: RunnerEvent[] = [];
  await runFlow(f, (e) => void events.push(e), { registry: testRegistry, ...opts });
  const done = events.at(-1);
  return {
    events,
    done: done?.event === "flow:done" ? done : undefined,
    started: events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : [])),
  };
}

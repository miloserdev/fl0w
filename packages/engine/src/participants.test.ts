import { describe, expect, it } from "vitest";
import { collect, edge, flow, node, testRegistry } from "./test-helpers";
import { participatingNodes } from "./participants";
import { runFlowInProcess } from "./spawn";
import type { RunnerEvent } from "@fl0w/schema";

const part = (f: ReturnType<typeof flow>, trigger?: string) => [...participatingNodes(f, testRegistry, trigger)].sort();

describe("participatingNodes: от каких нод идёт запуск", () => {
  it("без триггеров стартуют источники данных; всё достижимое участвует", () => {
    const f = flow(
      [node("s", "source", { json: 1 }), node("t", "transform"), node("r", "result"), node("orphan", "transform"), node("orphanRes", "result")],
      [edge("s", "t"), edge("t", "r")],
    );
    expect(part(f)).toEqual(["r", "s", "t"]);
  });

  it("с триггерами стартуют только они: «лишний» Source вне связи с триггером не участвует", () => {
    const f = flow(
      [node("m", "manual"), node("r1", "result"), node("s", "source", { json: 1 }), node("r2", "result")],
      [edge("m", "r1"), edge("s", "r2")],
    );
    expect(part(f)).toEqual(["m", "r1"]);
  });

  it("Source, питающий ноду после триггера, участвует", () => {
    const f = flow(
      [node("m", "manual"), node("s", "source", { json: 1 }), node("j", "join"), node("r", "result"), node("other", "source", { json: 2 })],
      [edge("m", "j", "out0", "in0"), edge("s", "j", "out0", "in1"), edge("j", "r")],
    );
    expect(part(f)).toEqual(["j", "m", "r", "s"]);
  });

  it("при плановом запуске только выбранный триггер и его ветка", () => {
    const f = flow(
      [node("a", "every"), node("b", "every"), node("ra", "result"), node("rb", "result")],
      [edge("a", "ra"), edge("b", "rb")],
    );
    expect(part(f, "a")).toEqual(["a", "ra"]);
    expect(part(f)).toEqual(["a", "b", "ra", "rb"]);
  });

  it("пустой флоу и флоу без стартовых нод — никто не участвует", () => {
    expect(part(flow([], []))).toEqual([]);
    expect(part(flow([node("t", "transform"), node("r", "result")], [edge("t", "r")]))).toEqual([]);
  });
});

describe("запуск не трогает ноды без связи со стартом", () => {
  it("брошенные на холст ноды не выполняются (раньше выполнялась любая нода без подключённых входов)", async () => {
    const f = flow(
      [
        node("s", "source", { json: 5 }),
        node("res", "result"),
        // «сиротские» ноды: ничего не подключено
        node("lone", "transform"),
        node("loneBoom", "boom"),
        node("loneRes", "result"),
        node("loneBranch", "branch"),
      ],
      [edge("s", "res")],
    );
    const { started, done } = await collect(f);
    expect(started).toEqual(["s", "res"]);
    expect(done).toEqual({ event: "flow:done", result: 5 }); // boom не выполнялся — иначе был бы flow:done с ошибкой
  });

  it("лишний Source не запускается, если во флоу есть триггер", async () => {
    const f = flow(
      [node("m", "manual"), node("r1", "result"), node("s", "source", { json: 1 }), node("r2", "result")],
      [edge("m", "r1"), edge("s", "r2")],
    );
    const { started } = await collect(f);
    expect(started).toEqual(["m", "r1"]);
  });

  it("Source, питающий ветку триггера, выполняется", async () => {
    const f = flow(
      [node("m", "manual"), node("s", "source", { json: "B" }), node("j", "join"), node("r", "result")],
      [edge("m", "j", "out0", "in0"), edge("s", "j", "out0", "in1"), edge("j", "r")],
    );
    const { started, done } = await collect(f);
    expect(started).toEqual(["m", "s", "j", "r"]);
    expect((done?.result as { b: string }).b).toBe("B");
  });

  it("нода с подключённым ТОЛЬКО частью входов ждёт остальные (wait-all сохранён)", async () => {
    const f = flow(
      [node("s", "source", { json: 1 }), node("m", "merge"), node("r", "result")],
      [edge("s", "m", "out0", "in0"), edge("m", "r")], // из четырёх входов Merge подключён один — ждёт только его
    );
    const { started, done } = await collect(f);
    expect(started).toEqual(["s", "m", "r"]);
    expect(done?.result).toEqual([1]);
  });

  it("в отдельном процессе правило то же", async () => {
    const f = flow(
      [node("s", "source", { json: 1 }), node("res", "result"), node("lone", "code", { code: "throw new Error('must not run')" }), node("loneRes", "result")],
      [edge("s", "res"), edge("lone", "loneRes")],
    );
    const events: RunnerEvent[] = [];
    await runFlowInProcess(f, (e) => void events.push(e), { timeoutMs: 20000 });
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).toEqual(["s", "res"]);
    expect(events.at(-1)).toEqual({ event: "flow:done", result: 1 });
  });
});

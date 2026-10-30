import { beforeEach, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@fl0w/schema";
import { runFlow } from "./run";
import { collect, edge, flow, Join, node, Probe, testRegistry } from "./test-helpers";

const demo = flow(
  [node("src", "source", { json: { n: 1 } }), node("tr", "transform"), node("res", "result")],
  [edge("src", "tr"), edge("tr", "res")],
);

describe("runFlow", () => {
  it("демо Source → Transform → Result даёт результат и события по нодам", async () => {
    const { events, done } = await collect(demo);
    expect(done).toEqual({ event: "flow:done", result: { n: 1, tagged: true } });
    expect(events.map((e) => (e.event === "flow:done" ? e.event : `${e.event}:${e.nodeId}`))).toEqual([
      "node:start:src",
      "node:done:src",
      "node:start:tr",
      "node:log:tr",
      "node:done:tr",
      "node:start:res",
      "node:done:res",
      "flow:done",
    ]);
  });

  it("node:done несёт output блока", async () => {
    const { events } = await collect(demo);
    expect(events).toContainEqual({ event: "node:done", nodeId: "tr", output: { out0: { n: 1, tagged: true } } });
  });

  it("применяет default из params", async () => {
    const f = flow([node("s", "source", { json: 4 }), node("t", "transform", { mode: "double" }), node("r", "result")], [
      edge("s", "t"),
      edge("t", "r"),
    ]);
    expect((await collect(f)).done?.result).toBe(8);
    const withDefault = flow([node("s", "source", {})], []);
    const { events } = await collect(withDefault);
    expect(events).toContainEqual({ event: "node:done", nodeId: "s", output: { out0: {} } });
  });

  it("невалидный флоу не запускается, а даёт flow:done с ошибкой", async () => {
    const cyc = flow([node("a", "transform"), node("b", "transform")], [edge("a", "b"), edge("b", "a")]);
    const { events, done } = await collect(cyc);
    expect(events).toHaveLength(1);
    expect(done?.error).toMatch(/Invalid flow: .*cycle/);
  });

  it("мусор на входе тоже не роняет движок", async () => {
    expect((await collect("not a flow")).done?.error).toMatch(/Invalid flow/);
  });

  describe("wait-all", () => {
    beforeEach(() => {
      Join.calls = 0;
    });

    it("нода с двумя входами ждёт обе ветки и запускается один раз", async () => {
      const f = flow(
        [
          node("s", "source", { json: 1 }),
          node("l", "transform", { mode: "double" }),
          node("r", "transform", { mode: "double" }),
          node("j", "join"),
          node("res", "result"),
        ],
        [edge("s", "l"), edge("s", "r"), edge("l", "j", "out0", "in0"), edge("r", "j", "out0", "in1"), edge("j", "res")],
      );
      const { started, done } = await collect(f);
      expect(Join.calls).toBe(1);
      expect(started.indexOf("j")).toBeGreaterThan(started.indexOf("l"));
      expect(started.indexOf("j")).toBeGreaterThan(started.indexOf("r"));
      expect(done?.result).toEqual({ a: 2, b: 2 });
    });

    it("порядок объявления нод не важен", async () => {
      const f = flow(
        [node("res", "result"), node("t", "transform"), node("s", "source", { json: 1 })],
        [edge("s", "t"), edge("t", "res")],
      );
      expect((await collect(f)).done?.result).toEqual({ tagged: true });
    });
  });

  describe("пустой out-порт", () => {
    const branchFlow = (value: number) =>
      flow(
        [
          node("s", "source", { json: value }),
          node("b", "branch"),
          node("pos", "transform", { mode: "double" }),
          node("neg", "transform", { mode: "double" }),
          node("rPos", "result"),
          node("rNeg", "result"),
        ],
        [
          edge("s", "b"),
          edge("b", "pos", "out0", "in0"),
          edge("b", "neg", "out1", "in0"),
          edge("pos", "rPos"),
          edge("neg", "rNeg"),
        ],
      );

    it("ветка без данных не запускается, вниз по цепочке тоже", async () => {
      const { started, done } = await collect(branchFlow(5));
      expect(started).toEqual(["s", "b", "pos", "rPos"]);
      expect(done).toEqual({ event: "flow:done", result: 10 });
    });

    it("другая ветка", async () => {
      const { started, done } = await collect(branchFlow(-3));
      expect(started).toEqual(["s", "b", "neg", "rNeg"]);
      expect(done?.result).toBe(-6);
    });

    it("join после невзятой ветки остаётся неготовым", async () => {
      const f = flow(
        [
          node("s", "source", { json: 5 }),
          node("b", "branch"),
          node("j", "join"),
          node("res", "result"),
        ],
        [edge("s", "b"), edge("b", "j", "out0", "in0"), edge("b", "j", "out1", "in1"), edge("j", "res")],
      );
      const { started, done } = await collect(f);
      expect(started).toEqual(["s", "b"]);
      expect(done).toEqual({ event: "flow:done" }); // Result не достигнут — результата нет
    });
  });

  describe("Result", () => {
    it("несколько Result → объект по id нод", async () => {
      const f = flow(
        [node("s", "source", { json: 7 }), node("r1", "result"), node("r2", "result")],
        [edge("s", "r1"), edge("s", "r2")],
      );
      expect((await collect(f)).done?.result).toEqual({ r1: 7, r2: 7 });
    });

    it("без Result результата нет", async () => {
      const f = flow([node("s", "source", { json: 7 })], []);
      expect((await collect(f)).done).toEqual({ event: "flow:done" });
    });
  });

  describe("ошибки", () => {
    it("исключение блока → node:error и остановка", async () => {
      const f = flow(
        [node("s", "source", { json: 1 }), node("x", "boom"), node("res", "result")],
        [edge("s", "x"), edge("x", "res")],
      );
      const { events, started, done } = await collect(f);
      expect(events).toContainEqual({ event: "node:error", nodeId: "x", error: "kaboom" });
      expect(started).toEqual(["s", "x"]);
      expect(done?.error).toBe('Node "x" failed: kaboom');
      expect(done?.result).toBeUndefined();
    });

    it("не-JSON вывод блока → node:error", async () => {
      const { events, done } = await collect(flow([node("b", "bad")], []));
      expect(events).toContainEqual({ event: "node:error", nodeId: "b", error: "Block returned a non-JSON output" });
      expect(done?.error).toMatch(/failed/);
    });
  });

  describe("отмена", () => {
    it("abort до старта", async () => {
      const ac = new AbortController();
      ac.abort();
      const { events, done } = await collect(demo, { signal: ac.signal });
      expect(events.map((e) => e.event)).toEqual(["flow:done"]);
      expect(done?.error).toBe("Aborted");
    });

    it("abort во время выполнения блока", async () => {
      const ac = new AbortController();
      const f = flow([node("sl", "slow"), node("res", "result")], [edge("sl", "res")]);
      const p = collect(f, { signal: ac.signal });
      setTimeout(() => ac.abort(), 10);
      const { events, done } = await p;
      expect(events).toContainEqual({ event: "node:error", nodeId: "sl", error: "Aborted" });
      expect(done?.error).toMatch(/Aborted/);
    });
  });

  describe("доставка событий до запуска блока", () => {
    it("node:start дожидается обработчика: блок стартует только после него", async () => {
      Probe.trace.length = 0;
      await runFlow(
        flow([node("p", "probe")], []),
        async (e) => {
          if (e.event === "node:start") {
            await new Promise((r) => setTimeout(r, 30)); // «медленная» отправка события
            Probe.trace.push("start:delivered");
          }
        },
        { registry: testRegistry },
      );
      expect(Probe.trace).toEqual(["start:delivered", "block:run"]);
    });

    it("синхронные обработчики по-прежнему работают как раньше", async () => {
      const events: string[] = [];
      await runFlow(flow([node("p", "probe")], []), (e) => void events.push(e.event), { registry: testRegistry });
      expect(events).toEqual(["node:start", "node:done", "flow:done"]);
    });
  });

  describe("логи блоков (node:log)", () => {
    const logs = (events: Awaited<ReturnType<typeof collect>>["events"]) =>
      events.flatMap((e) => (e.event === "node:log" ? [e.message] : []));

    it("ctx.log превращается в событие между start и done", async () => {
      const { events } = await collect(demo);
      const i = events.findIndex((e) => e.event === "node:log");
      expect(events[i]).toEqual({ event: "node:log", nodeId: "tr", message: "transform:tag" });
      expect(events[i - 1]).toMatchObject({ event: "node:start", nodeId: "tr" });
      expect(events[i + 1]).toMatchObject({ event: "node:done", nodeId: "tr" });
    });

    it("поток логов обрезается, а не забивает канал", async () => {
      const { events } = await collect(flow([node("c", "chatty", { count: 5000 })], []));
      const lines = logs(events);
      expect(lines).toHaveLength(1001); // 1000 строк + маркер обрезки
      expect(lines.at(-1)).toBe("… log truncated");
    });

    it("после завершения ноды её логи не просачиваются в поток", async () => {
      const events: RunnerEvent[] = [];
      await runFlow(flow([node("c", "chatty")], []), (e) => {
      events.push(e);
    }, { registry: testRegistry });
      await new Promise((r) => setTimeout(r, 60)); // фоновый «late» уже должен был сработать
      expect(logs(events)).toEqual(["line 0", "line 1", "line 2"]);
      expect(events.at(-1)).toMatchObject({ event: "flow:done" });
    });
  });
});

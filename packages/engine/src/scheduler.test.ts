import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow, WatchMessage } from "@fl0w/schema";
import { RunHub } from "./hub";
import { Scheduler, type SchedulerRun } from "./scheduler";
import { FlowStore } from "./store";
import { edge, flow, node, testRegistry } from "./test-helpers";

const published = (
  id: string,
  every: { interval: number; unit: string } = { interval: 1, unit: "seconds" },
  status: "published" | "draft" = "published",
): Flow => ({
  ...flow([node("t", "every", every), node("r", "result")], [edge("t", "r")]),
  id,
  status,
});

function setup(run?: SchedulerRun) {
  const calls: { flowId: string; trigger: string }[] = [];
  const hub = new RunHub();
  const logs: string[] = [];
  const impl: SchedulerRun =
    run ??
    (async (f, onEvent, o) => {
      calls.push({ flowId: f.id, trigger: o.trigger });
      onEvent({ event: "node:start", nodeId: o.trigger });
      onEvent({ event: "flow:done", result: 1 });
    });
  const wrapped: SchedulerRun = async (f, onEvent, o) => {
    if (run) calls.push({ flowId: f.id, trigger: o.trigger });
    await impl(f, onEvent, o);
  };
  const store = new FlowStore("/nonexistent");
  const scheduler = new Scheduler({ store, hub, registry: testRegistry, run: wrapped, log: (m) => logs.push(m) });
  return { scheduler, hub, calls, logs, store };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Scheduler", () => {
  it("запускает флоу от триггера по периоду, а не сразу", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("f1", { interval: 5, unit: "seconds" }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ flowId: "f1", trigger: "t" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    scheduler.stop();
  });

  it("минуты и часы пересчитываются в мс", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("m", { interval: 2, unit: "minutes" }));
    scheduler.sync(published("h", { interval: 1, unit: "hours" }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.map((c) => c.flowId)).toEqual(["m"]);
    await vi.advanceTimersByTimeAsync(3_600_000 - 120_000);
    expect(calls.filter((c) => c.flowId === "h")).toHaveLength(1);
    scheduler.stop();
  });

  it("draft и снятие с публикации останавливают расписание", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("f"));
    expect(scheduler.isScheduled("f")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);

    scheduler.sync({ ...published("f"), status: "draft" });
    expect(scheduler.isScheduled("f")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);

    scheduler.sync(published("g", undefined, "draft"));
    expect(scheduler.isScheduled("g")).toBe(false);
  });

  it("повторная публикация заменяет расписание, а не дублирует", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("f", { interval: 1, unit: "seconds" }));
    scheduler.sync(published("f", { interval: 1, unit: "seconds" }));
    scheduler.sync(published("f", { interval: 10, unit: "seconds" }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toEqual([]); // старый период 1с больше не работает
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it("невалидный опубликованный флоу не ставится на расписание", async () => {
    const { scheduler, calls, logs } = setup();
    scheduler.sync(published("bad", { interval: 0, unit: "seconds" })); // interval < min
    scheduler.sync(published("bad2", { interval: 1, unit: "weeks" })); // неизвестная единица
    expect(scheduler.isScheduled("bad")).toBe(false);
    expect(scheduler.isScheduled("bad2")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/invalid, not scheduled/);
  });

  it("опубликованный флоу без триггеров не планируется", () => {
    const { scheduler } = setup();
    scheduler.sync({ ...flow([node("s", "source", { json: 1 })], []), id: "nt", status: "published" });
    expect(scheduler.isScheduled("nt")).toBe(false);
  });

  it("пока предыдущий запуск идёт, тик пропускается и об этом сообщается", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { scheduler, hub, calls } = setup(async (_f, onEvent) => {
      await hold;
      onEvent({ event: "flow:done" });
    });
    const msgs: WatchMessage[] = [];
    hub.subscribe("f", (m) => msgs.push(m));
    scheduler.sync(published("f"));

    await vi.advanceTimersByTimeAsync(3_000); // три тика, первый запуск всё ещё висит
    expect(calls).toHaveLength(1);
    expect(msgs.filter((m) => m.type === "run:skip")).toHaveLength(2);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2); // после завершения расписание продолжилось
    scheduler.stop();
  });

  it("события запуска попадают в хаб: старт, ноды, итог", async () => {
    const { scheduler, hub } = setup();
    const msgs: WatchMessage[] = [];
    hub.subscribe("f", (m) => msgs.push(m));
    scheduler.sync(published("f"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(msgs.map((m) => (m.type === "run:event" ? m.event.event : m.type))).toEqual([
      "run:start",
      "node:start",
      "flow:done",
    ]);
    expect(msgs[0]).toMatchObject({ trigger: "t" });
    expect(hub.lastRun("f")?.status).toBe("done");
    scheduler.stop();
  });

  it("исключение исполнителя закрывает запуск ошибкой, а расписание живёт", async () => {
    let n = 0;
    const { scheduler, hub } = setup(async () => {
      n++;
      throw new Error("executor exploded");
    });
    scheduler.sync(published("f"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(hub.lastRun("f")).toMatchObject({ status: "error", error: expect.stringMatching(/executor exploded/) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(n).toBe(3);
    scheduler.stop();
  });

  it("периоды длиннее лимита setTimeout (24.8 суток) не срабатывают сразу", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("long", { interval: 1000, unit: "hours" })); // ~41.7 суток
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000 * 3_600_000 - 60_000);
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it("stop снимает все таймеры", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(published("a"));
    scheduler.sync(published("b"));
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Scheduler.start — подъём после рестарта", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fl0w-sched-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("берёт из хранилища только опубликованные флоу", async () => {
    vi.useRealTimers();
    const store = new FlowStore(dir);
    await store.put(published("on"));
    await store.put(published("off", undefined, "draft"));
    const hub = new RunHub();
    const scheduler = new Scheduler({
      store,
      hub,
      registry: testRegistry,
      run: async (_f, onEvent) => {
        onEvent({ event: "flow:done" });
      },
    });
    await scheduler.start();
    expect(scheduler.isScheduled("on")).toBe(true);
    expect(scheduler.isScheduled("off")).toBe(false);
    scheduler.stop();
  });
});

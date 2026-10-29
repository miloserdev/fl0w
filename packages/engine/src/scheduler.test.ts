import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flow, Json, RunnerEvent, WatchMessage } from "@fl0w/schema";
import { RunHub } from "./hub";
import { Scheduler, SchedulerBusyError, type SchedulerRun } from "./scheduler";
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
  const calls: { flowId: string; trigger: string; triggerData?: Json }[] = [];
  const hub = new RunHub();
  const logs: string[] = [];
  const impl: SchedulerRun =
    run ??
    (async (f, onEvent, o) => {
      calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
      onEvent({ event: "node:start", nodeId: o.trigger });
      onEvent({ event: "flow:done", result: 1 });
    });
  const wrapped: SchedulerRun = async (f, onEvent, o) => {
    if (run) calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
    await impl(f, onEvent, o);
  };
  const store = new FlowStore("/nonexistent");
  const scheduler = new Scheduler({
    store,
    hub,
    registry: testRegistry,
    run: wrapped,
    log: (m) => logs.push(m),
    maxConcurrentHookRuns: 2,
  });
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

const hookFlow = (
  id: string,
  path = "orders",
  method = "POST",
  status: "published" | "draft" = "published",
  extra: Flow["nodes"] = [],
): Flow => ({
  ...flow([node("w", "webhook", { path, method }), node("r", "result"), ...extra], [edge("w", "r")]),
  id,
  status,
});

describe("Scheduler: вебхуки", () => {
  it("опубликованный вебхук регистрируется; путь нормализуется; метод точный, ANY — любой", () => {
    const { scheduler } = setup();
    scheduler.sync(hookFlow("a", "/orders/new/", "POST"));
    scheduler.sync(hookFlow("b", "any-path", "ANY"));
    expect(scheduler.findWebhook("POST", "orders/new")).toMatchObject({ nodeId: "w", flow: { id: "a" } });
    expect(scheduler.findWebhook("post", "orders/new")?.flow.id).toBe("a"); // регистр метода не важен
    expect(scheduler.findWebhook("GET", "orders/new")).toBeUndefined();
    expect(scheduler.findWebhook("DELETE", "any-path")?.flow.id).toBe("b");
    expect(scheduler.findWebhook("POST", "nope")).toBeUndefined();
    expect(scheduler.isScheduled("a")).toBe(true); // активен и без таймеров
  });

  it("draft и снятие с публикации убирают вебхук; повторная публикация переносит его", () => {
    const { scheduler } = setup();
    scheduler.sync(hookFlow("a", "one"));
    scheduler.sync(hookFlow("a", "two"));
    expect(scheduler.findWebhook("POST", "one")).toBeUndefined();
    expect(scheduler.findWebhook("POST", "two")).toBeDefined();
    scheduler.sync(hookFlow("a", "two", "POST", "draft"));
    expect(scheduler.findWebhook("POST", "two")).toBeUndefined();
    expect(scheduler.isScheduled("a")).toBe(false);
    scheduler.sync(hookFlow("d", "three", "POST", "draft"));
    expect(scheduler.findWebhook("POST", "three")).toBeUndefined();
  });

  it("конфликт пути: второй флоу не перехватывает чужой вебхук; problems() сообщает заранее", () => {
    const { scheduler, logs } = setup();
    scheduler.sync(hookFlow("first", "shared"));
    expect(scheduler.problems(hookFlow("second", "shared"))).toEqual(["Webhook POST shared is already used by flow first"]);
    expect(scheduler.problems(hookFlow("first", "shared"))).toEqual([]); // свой же путь при обновлении — не конфликт
    scheduler.sync(hookFlow("second", "shared"));
    expect(scheduler.findWebhook("POST", "shared")?.flow.id).toBe("first");
    expect(logs.join("\n")).toMatch(/already used by flow first/);
    scheduler.sync(hookFlow("first", "shared", "POST", "draft")); // освободил — путь снова доступен
    scheduler.sync(hookFlow("second", "shared"));
    expect(scheduler.findWebhook("POST", "shared")?.flow.id).toBe("second");
  });

  it("problems(): кривой путь, дубль внутри флоу, кривое расписание", () => {
    const { scheduler } = setup();
    expect(scheduler.problems(hookFlow("a", "a b"))[0]).toMatch(/Invalid webhook path/);
    const twice = hookFlow("a", "x", "POST", "published", [node("w2", "webhook", { path: "x", method: "POST" })]);
    expect(scheduler.problems(twice)).toEqual(["Webhook POST x is used by more than one trigger of this flow"]);
    expect(scheduler.problems(published("e", { interval: 1, unit: "weeks" }))[0]).toMatch(/Unknown unit/);
    expect(scheduler.problems(published("ok"))).toEqual([]);
  });

  it("trigger запускает флоу от нужной ноды с данными запроса; события идут в хаб и вызывающему", async () => {
    const { scheduler, hub, calls } = setup();
    scheduler.sync(hookFlow("a"));
    const msgs: WatchMessage[] = [];
    hub.subscribe("a", (m) => msgs.push(m));
    const seen: RunnerEvent[] = [];
    const payload = { method: "POST", body: { id: 1 } };
    await scheduler.trigger("a", "w", payload, (e) => void seen.push(e));
    expect(calls).toEqual([{ flowId: "a", trigger: "w", triggerData: payload }]);
    expect(seen.map((e) => e.event)).toEqual(["node:start", "flow:done"]);
    expect(msgs.map((m) => (m.type === "run:event" ? m.event.event : m.type))).toEqual(["run:start", "node:start", "flow:done"]);
    expect(hub.lastRun("a")?.status).toBe("done");
  });

  it("лимит параллельных запусков проверяется синхронно и освобождается после завершения", async () => {
    const releases: (() => void)[] = [];
    const { scheduler } = setup(async (_f, onEvent) => {
      await new Promise<void>((r) => releases.push(r));
      onEvent({ event: "flow:done" });
    });
    scheduler.sync(hookFlow("a"));
    const p1 = scheduler.trigger("a", "w", {});
    const p2 = scheduler.trigger("a", "w", {});
    expect(() => scheduler.trigger("a", "w", {})).toThrow(SchedulerBusyError); // лимит = 2
    releases[0]!();
    await p1;
    const p3 = scheduler.trigger("a", "w", {}); // слот освободился
    releases.slice(1).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    releases.forEach((r) => r());
    await Promise.all([p2, p3]);
    expect(() => scheduler.trigger("a", "w", {})).not.toThrow();
  });

  it("запуск по вебхуку не блокируется плановым запуском того же флоу", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { scheduler, calls } = setup(async (_f, onEvent) => {
      await hold;
      onEvent({ event: "flow:done" });
    });
    const mixed: Flow = {
      ...flow(
        [node("t", "every", { interval: 1, unit: "seconds" }), node("w", "webhook", { path: "p" }), node("r1", "result"), node("r2", "result")],
        [edge("t", "r1"), edge("w", "r2")],
      ),
      id: "mix",
      status: "published",
    };
    scheduler.sync(mixed);
    await vi.advanceTimersByTimeAsync(1000); // плановый запуск повис
    expect(calls).toHaveLength(1);
    void scheduler.trigger("mix", "w", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.trigger)).toEqual(["t", "w"]);
    release();
    scheduler.stop();
  });

  it("trigger неопубликованного флоу — ошибка", () => {
    const { scheduler } = setup();
    expect(() => scheduler.trigger("ghost", "w", {})).toThrow(/not published/);
    scheduler.sync(hookFlow("a"));
    scheduler.sync(hookFlow("a", "orders", "POST", "draft"));
    expect(() => scheduler.trigger("a", "w", {})).toThrow(/not published/);
  });

  it("stop снимает вебхуки", () => {
    const { scheduler } = setup();
    scheduler.sync(hookFlow("a"));
    scheduler.stop();
    expect(scheduler.findWebhook("POST", "orders")).toBeUndefined();
  });
});

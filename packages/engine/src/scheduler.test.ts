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

const withNodes = (id: string, nodes: Flow["nodes"], status: "published" | "draft" = "published"): Flow => ({
  ...flow([...nodes, node("r", "result")], [edge(nodes[0]!.id, "r")]),
  id,
  status,
});

describe("Scheduler: жизненный цикл флоу", () => {
  const activation = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("t", "activation_trigger", params)], status);

  it("publish / update / startup срабатывают только при своём поводе", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(activation("a"), "publish");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => (c.triggerData as { event: string }).event)).toEqual(["publish"]);
    scheduler.sync(activation("a"), "update");
    scheduler.sync(activation("a"), "startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => (c.triggerData as { event: string }).event)).toEqual(["publish", "update", "startup"]);
    scheduler.stop();
  });

  it("без повода sync ничего не запускает; draft тоже", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(activation("a"));
    scheduler.sync(activation("b", {}, "draft"), "publish");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
  });

  it("флаги onPublish/onUpdate/onStartup отключают события", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync(activation("a", { onPublish: false, onUpdate: false }), "publish");
    scheduler.sync(activation("a", { onPublish: false, onUpdate: false }), "update");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    scheduler.sync(activation("a", { onPublish: false, onUpdate: false }), "startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  it("Workflow Trigger не реагирует на старт сервера", async () => {
    const { scheduler, calls } = setup();
    const f = withNodes("w", [node("t", "workflow_trigger")]);
    scheduler.sync(f, "startup");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    scheduler.sync(f, "publish");
    scheduler.sync(f, "update");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });

  it("данные события: повод, время и флоу", async () => {
    const { scheduler, calls } = setup();
    scheduler.sync({ ...activation("a"), name: "My flow" }, "publish");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({ flowId: "a", trigger: "t", triggerData: { event: "publish", flow: { id: "a", name: "My flow" }, at: expect.any(String) } });
  });

  it("start() поднимает флоу из хранилища с поводом startup", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "fl0w-life-"));
    try {
      const store = new FlowStore(dir);
      await store.put(activation("persisted"));
      await store.put(activation("draft-one", {}, "draft"));
      const calls: string[] = [];
      const scheduler = new Scheduler({
        store,
        hub: new RunHub(),
        registry: testRegistry,
        run: async (f, onEvent, o) => {
          calls.push(`${f.id}:${(o.triggerData as { event: string }).event}`);
          onEvent({ event: "flow:done" });
        },
      });
      await scheduler.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual(["persisted:startup"]);
      scheduler.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Scheduler: Error Trigger", () => {
  const failing = (id: string) => withNodes(id, [node("t", "every", { interval: 1, unit: "seconds" })]);
  const handler = (id: string, flows: string[] = []) => withNodes(id, [node("h", "error_trigger", { flows })]);

  /** Запуск «упавшего» флоу даёт flow:done с ошибкой и node:error; обработчики завершаются успешно. */
  const runner = (failIds: string[]) =>
    setup(async (f, onEvent) => {
      if (failIds.includes(f.id)) {
        onEvent({ event: "node:error", nodeId: "boomNode", error: "kaboom" });
        onEvent({ event: "flow:done", error: 'Node "boomNode" failed: kaboom' });
      } else onEvent({ event: "flow:done" });
    });

  it("упавший автоматический запуск вызывает обработчик с деталями ошибки", async () => {
    const { scheduler, calls } = runner(["bad"]);
    scheduler.sync(handler("h1"));
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.flowId)).toEqual(["bad", "h1"]);
    expect(calls[1]).toMatchObject({
      trigger: "h",
      triggerData: {
        flow: { id: "bad", name: "test" },
        run: { id: expect.stringMatching(/^run_/), trigger: "t" },
        error: { message: "kaboom", node: "boomNode" }, // сообщение самой ноды, без обёртки итога
        at: expect.any(String),
      },
    });
    scheduler.stop();
  });

  it("если упала не нода (процесс, невалидный флоу) — сообщение итога запуска и node: null", async () => {
    const { scheduler, calls } = setup(async (f, onEvent) => {
      onEvent({ event: "flow:done", error: f.id === "bad" ? "Runner exited unexpectedly (code 3)" : undefined });
    });
    scheduler.sync(handler("h1"));
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[1]!.triggerData).toMatchObject({ error: { message: "Runner exited unexpectedly (code 3)", node: null } });
    scheduler.stop();
  });

  it("успешные запуски обработчик не вызывают", async () => {
    const { scheduler, calls } = runner([]);
    scheduler.sync(handler("h1"));
    scheduler.sync(failing("good"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.map((c) => c.flowId)).toEqual(["good", "good", "good"]);
    scheduler.stop();
  });

  it("список flows ограничивает область; пустой список — любые флоу", async () => {
    const { scheduler, calls } = runner(["bad1", "bad2"]);
    scheduler.sync(handler("only1", ["bad1"]));
    scheduler.sync(handler("all"));
    scheduler.sync(failing("bad1"));
    scheduler.sync(failing("bad2"));
    await vi.advanceTimersByTimeAsync(1000);
    const byHandler = (id: string) => calls.filter((c) => c.flowId === id).map((c) => (c.triggerData as { flow: { id: string } }).flow.id).sort();
    expect(byHandler("only1")).toEqual(["bad1"]);
    expect(byHandler("all")).toEqual(["bad1", "bad2"]);
    scheduler.stop();
  });

  it("обработчик не вызывается для неопубликованных и снятых флоу; снятие обработчика отключает его", async () => {
    const { scheduler, calls } = runner(["bad"]);
    scheduler.sync(handler("h1"));
    scheduler.sync({ ...handler("h2"), status: "draft" });
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.flowId === "h2")).toEqual([]);
    expect(calls.filter((c) => c.flowId === "h1")).toHaveLength(1);
    scheduler.sync({ ...handler("h1"), status: "draft" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.flowId === "h1")).toHaveLength(1);
    scheduler.stop();
  });

  it("падение самого обработчика не порождает цепочку; флоу может обрабатывать собственные ошибки", async () => {
    const { scheduler, calls } = runner(["selfy", "h1"]);
    scheduler.sync(handler("h1")); // обработчик, который сам падает
    scheduler.sync(failing("selfy"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.flowId)).toEqual(["selfy", "h1"]); // h1 упал, но новых вызовов нет
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);

    const both = withNodes("both", [node("t", "every", { interval: 1, unit: "seconds" }), node("h", "error_trigger")]);
    const second = runner(["both"]);
    second.scheduler.sync(both);
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.calls.map((c) => c.trigger)).toEqual(["t", "h"]); // сам себе обработчик (как в n8n)
    scheduler.stop();
    second.scheduler.stop();
  });

  it("при исчерпании лимита параллельных запусков обработчик пропускается без исключения", async () => {
    const releases: (() => void)[] = [];
    const { scheduler, hub } = setup(async (f, onEvent) => {
      if (f.id === "bad") {
        onEvent({ event: "flow:done", error: "boom" });
        return;
      }
      await new Promise<void>((r) => releases.push(r)); // обработчики зависают и занимают слоты
      onEvent({ event: "flow:done" });
    });
    const msgs: WatchMessage[] = [];
    scheduler.sync(handler("h1"));
    scheduler.sync(handler("h2"));
    scheduler.sync(handler("h3"));
    hub.subscribe("h3", (m) => void msgs.push(m));
    scheduler.sync(failing("bad"));
    await vi.advanceTimersByTimeAsync(1000); // лимит 2: третий обработчик отказан
    expect(releases).toHaveLength(2);
    expect(msgs.some((m) => m.type === "run:skip")).toBe(true);
    releases.forEach((r) => r());
    scheduler.stop();
  });

  it("problems() сообщает о кривых параметрах обработчика", () => {
    const { scheduler } = setup();
    expect(scheduler.problems(handler("h", ["a"]))).toEqual([]);
    expect(scheduler.problems(withNodes("h", [node("h", "error_trigger", { flows: [1] })]))[0]).toMatch(/list of strings/);
  });
});

describe("Scheduler: Local File Trigger", () => {
  const fileFlow = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("f", "local_file_trigger", params)], status);

  function watcherSetup() {
    const watchers: { spec: unknown; emit: (p: Json) => void; stopped: boolean }[] = [];
    const base = setup();
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent, o) => {
        base.calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      maxConcurrentHookRuns: 2,
      watchFiles: (spec, onChange) => {
        const w = { spec, emit: onChange, stopped: false };
        watchers.push(w);
        return () => void (w.stopped = true);
      },
    });
    return { ...base, scheduler, watchers };
  }

  it("публикация ставит наблюдателя с нормализованными параметрами; событие запускает флоу с данными файла", async () => {
    const { scheduler, watchers, calls } = watcherSetup();
    scheduler.sync(fileFlow("a", { path: "./inbox/", event: "add", pattern: "*.csv", recursive: true }));
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.spec).toEqual({ path: "inbox", event: "add", pattern: "*.csv", recursive: true });
    const payload = { event: "add", path: "inbox/a.csv", name: "a.csv", size: 3, modifiedAt: "x" };
    watchers[0]!.emit(payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ flowId: "a", trigger: "f", triggerData: payload }]);
    expect(scheduler.isScheduled("a")).toBe(true);
  });

  it("снятие с публикации, повторная публикация и stop отписывают наблюдателя", () => {
    const { scheduler, watchers } = watcherSetup();
    scheduler.sync(fileFlow("a"));
    scheduler.sync(fileFlow("a", { path: "other" })); // повторная публикация заменяет наблюдателя
    expect(watchers.map((w) => w.stopped)).toEqual([true, false]);
    scheduler.sync(fileFlow("a", {}, "draft"));
    expect(watchers.map((w) => w.stopped)).toEqual([true, true]);
    scheduler.sync(fileFlow("b"));
    scheduler.stop();
    expect(watchers.every((w) => w.stopped)).toBe(true);
    expect(scheduler.isScheduled("b")).toBe(false);
  });

  it("кривой путь не активируется и виден в problems(); без наблюдателя — запись в лог", () => {
    const { scheduler, logs, watchers } = watcherSetup();
    expect(scheduler.problems(fileFlow("a", { path: "../x" }))[0]).toMatch(/\.\./);
    scheduler.sync(fileFlow("a", { path: "../x" }));
    expect(watchers).toEqual([]);
    expect(logs.join("\n")).toMatch(/not activated/);

    const plain = setup();
    plain.scheduler.sync(fileFlow("b"));
    expect(plain.logs.join("\n")).toMatch(/needs a file watcher/);
  });

  it("поток событий упирается в лимит: лишние пропускаются, остальные выполняются", async () => {
    const releases: (() => void)[] = [];
    const base = setup();
    const watchers: ((p: Json) => void)[] = [];
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent) => {
        await new Promise<void>((r) => releases.push(r));
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      maxConcurrentHookRuns: 2,
      watchFiles: (_s, onChange) => (watchers.push(onChange), () => {}),
    });
    scheduler.sync(fileFlow("a"));
    for (let i = 0; i < 5; i++) watchers[0]!({ event: "add", path: `f${i}`, name: `f${i}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    expect(base.logs.filter((l) => /too many concurrent/.test(l))).toHaveLength(3);
    releases.forEach((r) => r());
  });
});

describe("Scheduler: Telegram Trigger", () => {
  const TG_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const tgFlow = (id: string, params: Record<string, Json> = {}, status: "published" | "draft" = "published") =>
    withNodes(id, [node("tg", "telegram_trigger", { token: TG_TOKEN, ...params })], status);

  function tgSetup(limit = 2) {
    const subs: { spec: import("@fl0w/blocks").TelegramSpec; emit: (u: Json) => void; stopped: boolean }[] = [];
    const base = setup();
    const releases: (() => void)[] = [];
    const scheduler = new Scheduler({
      store: new FlowStore("/nonexistent"),
      hub: base.hub,
      registry: testRegistry,
      run: async (f, onEvent, o) => {
        base.calls.push({ flowId: f.id, trigger: o.trigger, triggerData: o.triggerData });
        if (hold) await new Promise<void>((r) => releases.push(r));
        onEvent({ event: "flow:done" });
      },
      log: (m) => base.logs.push(m),
      maxConcurrentHookRuns: limit,
      pollTelegram: (spec, emit) => {
        const s = { spec, emit, stopped: false };
        subs.push(s);
        return () => void (s.stopped = true);
      },
    });
    let hold = false;
    return { ...base, scheduler, subs, releases, hold: (v: boolean) => (hold = v) };
  }
  const upd = (n: number): Json => ({ update_id: n, message: { message_id: n, chat: { id: 1 }, text: `m${n}` } });

  it("публикация подписывает бота; обновление запускает флоу с данными обновления", async () => {
    const { scheduler, subs, calls } = tgSetup();
    scheduler.sync(tgFlow("a", { updates: ["message", "callback_query"], chatIds: "12, -100", userIds: "5", dropPending: true }));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.spec).toEqual({ token: TG_TOKEN, updates: ["message", "callback_query"], chatIds: ["12", "-100"], userIds: ["5"], dropPending: true });
    subs[0]!.emit(upd(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ flowId: "a", trigger: "tg", triggerData: upd(1) }]);
    expect(scheduler.isScheduled("a")).toBe(true);
  });

  it("токен не попадает в лог (только id бота)", () => {
    const { scheduler, logs } = tgSetup();
    scheduler.sync(tgFlow("a"));
    const text = logs.join("\n");
    expect(text).toContain("Telegram bot 123456");
    expect(text).not.toContain(TG_TOKEN);
    expect(text).not.toContain("ABC-DEF");
  });

  it("снятие с публикации, повторная публикация и stop отписывают бота", () => {
    const { scheduler, subs } = tgSetup();
    scheduler.sync(tgFlow("a"));
    scheduler.sync(tgFlow("a", { updates: ["callback_query"] }));
    expect(subs.map((s) => s.stopped)).toEqual([true, false]);
    scheduler.sync(tgFlow("a", {}, "draft"));
    expect(subs.map((s) => s.stopped)).toEqual([true, true]);
    scheduler.sync(tgFlow("b"));
    scheduler.stop();
    expect(subs.every((s) => s.stopped)).toBe(true);
  });

  it("при исчерпании слотов обновления НЕ теряются: ждут в очереди и идут по порядку", async () => {
    const { scheduler, subs, calls, releases, hold } = tgSetup(2);
    hold(true);
    scheduler.sync(tgFlow("a"));
    for (let i = 1; i <= 5; i++) subs[0]!.emit(upd(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2); // два слота заняты, три ждут
    releases.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(4);
    releases.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => (c.triggerData as { update_id: number }).update_id)).toEqual([1, 2, 3, 4, 5]);
    releases.splice(0).forEach((r) => r());
  });

  it("снятие флоу с публикации выбрасывает его ожидающие обновления", async () => {
    const { scheduler, subs, calls, releases, hold } = tgSetup(1);
    hold(true);
    scheduler.sync(tgFlow("a"));
    for (let i = 1; i <= 3; i++) subs[0]!.emit(upd(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    scheduler.sync(tgFlow("a", {}, "draft"));
    releases.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // 2 и 3 не запустились
  });

  it("переполнение очереди (500) отбрасывает лишнее и пишет в лог", async () => {
    const { scheduler, subs, calls, releases, hold, logs } = tgSetup(1);
    hold(true);
    scheduler.sync(tgFlow("a"));
    for (let i = 1; i <= 505; i++) subs[0]!.emit(upd(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(logs.filter((l) => /event queue is full/.test(l))).toHaveLength(4); // 1 в работе + 500 в очереди, остальные 4 отброшены
    scheduler.sync(tgFlow("a", {}, "draft"));
    releases.splice(0).forEach((r) => r());
  });

  it("problems(): секрет не задан, кривой токен, неизвестный тип, кривые id", () => {
    const { scheduler } = tgSetup();
    delete process.env["FL0W_SECRET_TELEGRAM_BOT_TOKEN"];
    expect(scheduler.problems(tgFlow("a", { token: "" }))[0]).toMatch(/FL0W_SECRET_TELEGRAM_BOT_TOKEN is not set on the server/);
    expect(scheduler.problems(tgFlow("a", { token: "env:PATH" }))[0]).toMatch(/Only server variables named FL0W_SECRET_/);
    expect(scheduler.problems(tgFlow("a", { token: "garbage" }))[0]).toMatch(/invalid format/);
    expect(scheduler.problems(tgFlow("a", { updates: ["messages"] }))[0]).toMatch(/unknown update type "messages"/);
    expect(scheduler.problems(tgFlow("a", { updates: [] }))[0]).toMatch(/at least one update type/);
    expect(scheduler.problems(tgFlow("a", { chatIds: "abc" }))[0]).toMatch(/not a valid chat id/);
    expect(scheduler.problems(tgFlow("a", { userIds: "@name" }))[0]).toMatch(/not a valid user id/);
    expect(scheduler.problems(tgFlow("a", { chatIds: "@mychannel, -100123", userIds: "42", updates: ["*"] }))).toEqual([]);
    expect(scheduler.problems(tgFlow("a"))).toEqual([]);
  });

  it("токен из переменной окружения разрешается при подписке; без поллера — запись в лог", () => {
    process.env["FL0W_SECRET_TG_TEST"] = "999999:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11";
    try {
      const { scheduler, subs } = tgSetup();
      scheduler.sync(tgFlow("a", { token: "env:FL0W_SECRET_TG_TEST" }));
      expect(subs[0]!.spec.token).toBe("999999:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11");
      const plain = setup();
      plain.scheduler.sync(tgFlow("b"));
      expect(plain.logs.join("\n")).toMatch(/needs a Telegram poller/);
    } finally {
      delete process.env["FL0W_SECRET_TG_TEST"];
    }
  });
});

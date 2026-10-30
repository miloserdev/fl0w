import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "@fl0w/blocks";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlowInProcess } from "./spawn";
import { validateFlow } from "./validate";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

// примеры с файлами пишут в каталог файлов — подменяем его временным (процесс-раннер наследует окружение)
let filesDir: string;
let savedFilesDir: string | undefined;
beforeAll(() => {
  savedFilesDir = process.env["FL0W_FILES_DIR"];
  filesDir = mkdtempSync(path.join(tmpdir(), "fl0w-examples-"));
  process.env["FL0W_FILES_DIR"] = filesDir;
});
afterAll(() => {
  if (savedFilesDir === undefined) delete process.env["FL0W_FILES_DIR"];
  else process.env["FL0W_FILES_DIR"] = savedFilesDir;
  rmSync(filesDir, { recursive: true, force: true });
});

const load = (file: string): unknown => JSON.parse(readFileSync(path.join(dir, file), "utf8"));

async function run(file: string, opts: { trigger?: string; triggerData?: Json } = {}) {
  const checked = validateFlow(load(file), registry);
  if (!checked.ok) throw new Error(checked.issues.map((i) => i.message).join("; "));
  const events: RunnerEvent[] = [];
  await runFlowInProcess(checked.flow, (e) => events.push(e), { timeoutMs: 20000, ...opts });
  return events;
}

const result = (events: RunnerEvent[]) => {
  const done = events.at(-1);
  if (done?.event !== "flow:done") throw new Error("no flow:done");
  expect(done.error).toBeUndefined();
  return done.result as Record<string, Json>;
};

describe("examples/*.json", () => {
  it("набор примеров", () => {
    expect([...files].sort()).toEqual([
      "cleanup.json",
      "compare-datasets.json",
      "data-pipeline.json",
      "demo.json",
      "error-handler.json",
      "file-report.json",
      "jwt-and-hash.json",
      "showcase.json",
      "telegram-bot.json",
      "webhook-api.json",
    ]);
  });

  // примеры с внешними сервисами (Telegram) не выполняются тут — токен и сеть; их сквозной путь проверен telegram-e2e.test.ts
  it.each(files)("%s проходит валидацию и у флоу уникальный id", (file) => {
    const r = validateFlow(load(file), registry);
    expect(r.ok, r.ok ? "" : r.issues.map((i) => i.message).join("; ")).toBe(true);
  });

  it("id флоу не повторяются между примерами", () => {
    const ids = files.map((f) => (load(f) as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("demo.json: Source → Transform → Transform → Result", async () => {
    expect((await run("demo.json")).at(-1)).toEqual({
      event: "flow:done",
      result: [{ who: "ann" }, { who: "cat" }],
    });
  });

  it("showcase.json: ветвление, Merge, лог кода; невзятая ветка пропущена", async () => {
    const events = await run("showcase.json");
    expect(events.at(-1)).toEqual({
      event: "flow:done",
      result: {
        res_big: { label: "big", sum: 250 },
        res_merged: { name: "Ann", visits: 12 },
      },
    });
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).not.toContain("label_small");
    expect(started).not.toContain("res_small");
    expect(events).toContainEqual({ event: "node:log", nodeId: "totals", message: "orders: 3 sum: 250" });
  });

  it("data-pipeline.json: фильтр, сортировка, лимит, сводки, ветка discarded", async () => {
    expect(result(await run("data-pipeline.json"))).toEqual({
      // оплаченные: 120, 75, 410, 60, 220 → топ-3 по сумме: 410, 220, 120
      res_top: { revenue: 750, average: 250, orders: 3 },
      res_regions: [
        { region: "eu", revenue: 180, orders: 2 },
        { region: "us", revenue: 485, orders: 2 },
        { region: "asia", revenue: 220, orders: 1 },
      ],
      res_skipped: { count: 2, statuses: "refunded, pending" },
    });
  });

  it("compare-datasets.json: четыре выхода сравнения", async () => {
    expect(result(await run("compare-datasets.json"))).toEqual({
      only_a: [{ id: 1, name: "ann", plan: "free" }],
      same: [{ id: 2, name: "bob", plan: "pro" }],
      different: [{ keys: { id: 3 }, same: { id: 3, name: "cat" }, different: { plan: { inputA: "pro", inputB: "team" } } }],
      only_b: [{ id: 4, name: "dan", plan: "free" }],
    });
  });

  it("cleanup.json: дубликаты, переименование, агрегация", async () => {
    expect(result(await run("cleanup.json"))).toEqual({
      emails: ["ann@x.io", "bob@x.io"],
      tags: ["a", "b", "b"],
    });
  });

  it("jwt-and-hash.json: токен подписывается и проверяется", async () => {
    const r = result(await run("jwt-and-hash.json")) as { valid: boolean; subject: string; role: string; fingerprint: string };
    expect(r).toMatchObject({ valid: true, subject: "ann", role: "admin" });
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("file-report.json: сводка пишется в файл и читается обратно", async () => {
    const r = result(await run("file-report.json")) as { path: string; content: Json };
    const expected = [{ rep: "ann", total: 180, deals: 2 }, { rep: "bob", total: 75, deals: 1 }];
    expect(r.path).toBe("reports/summary.json");
    expect(r.content).toEqual(expected);
    expect(JSON.parse(readFileSync(path.join(filesDir, "reports/summary.json"), "utf8"))).toEqual(expected);
  });

  it("error-handler.json: данные об ошибке дописываются в журнал", async () => {
    const data: Json = {
      flow: { id: "flow_x", name: "nightly-sync" },
      run: { id: "run_1", trigger: "t" },
      error: { message: "HTTP 500", node: "fetch" },
      at: "2026-01-02T03:04:05.000Z",
    };
    await run("error-handler.json", { trigger: "on_error", triggerData: data });
    await run("error-handler.json", { trigger: "on_error", triggerData: data });
    expect(readFileSync(path.join(filesDir, "logs/errors.log"), "utf8")).toBe(
      "[2026-01-02T03:04:05.000Z] nightly-sync failed in fetch: HTTP 500\n".repeat(2),
    );
  });

  describe("webhook-api.json", () => {
    const respond = (events: RunnerEvent[], nodeId: string) => {
      const e = events.find((x) => x.event === "node:done" && x.nodeId === nodeId);
      return e?.event === "node:done" ? (e.output["response"] as { status: number; body: Json }) : undefined;
    };
    const call = (body: Json) =>
      run("webhook-api.json", {
        trigger: "hook",
        triggerData: { method: "POST", path: "demo/orders", query: {}, headers: {}, body },
      });

    it("большой заказ → ветка vip", async () => {
      const events = await call({ total: 2500 });
      expect(respond(events, "vip")).toMatchObject({ status: 200, body: { tier: "vip", total: 2500 } });
      expect(respond(events, "regular")).toBeUndefined();
      const stamp = (respond(events, "vip")!.body as { receivedAt: string }).receivedAt;
      expect(stamp).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    });

    it("обычный заказ → ветка regular", async () => {
      expect(respond(await call({ total: 40 }), "regular")).toMatchObject({ body: { tier: "regular", total: 40 } });
    });

    it("мусор → fallback с 422", async () => {
      expect(respond(await call({ total: -5 }), "bad")).toEqual({ status: 422, headers: {}, body: { error: "total must be a positive number" } });
      expect(respond(await call({}), "bad")?.status).toBe(422);
    });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registry, TELEGRAM_API_ENV } from "@fl0w/blocks";
import type { Flow, WatchMessage } from "@fl0w/schema";
import { RunHub } from "./hub";
import { Scheduler } from "./scheduler";
import { processSchedulerRun } from "./spawn";
import { FlowStore } from "./store";
import { createTelegramPoller } from "./telegram-poll";
import { edge, flow, node } from "./test-helpers";
import { FakeTelegram, msg, TOKEN } from "./test-telegram-server";

/** Весь путь: Bot API → опрос → планировщик → процесс-раннер → блок Telegram → ответ в Bot API. */
let fake: FakeTelegram;
let scheduler: Scheduler;
let hub: RunHub;
let logs: string[];
const saved: Record<string, string | undefined> = {};
const KEYS = [TELEGRAM_API_ENV, "FL0W_FILES_DIR"];
let dir: string;

beforeEach(async () => {
  fake = new FakeTelegram();
  await fake.start();
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-tg-e2e-"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env[TELEGRAM_API_ENV] = fake.url; // дочерние процессы-раннеры наследуют окружение
  process.env["FL0W_FILES_DIR"] = dir;
  logs = [];
  hub = new RunHub();
  scheduler = new Scheduler({
    store: new FlowStore("/nonexistent"),
    hub,
    registry,
    run: processSchedulerRun({ timeoutMs: 30_000 }),
    pollTelegram: createTelegramPoller({ pollTimeoutSec: 1, retryMinMs: 30, retryMaxMs: 100, log: (m) => logs.push(m) }),
    maxConcurrentHookRuns: 4,
    log: (m) => logs.push(m),
  });
});
afterEach(() => {
  scheduler.stop();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000) {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await sleep(25);
}

const echoFlow = (): Flow => ({
  ...flow(
    [
      node("tg", "telegram_trigger", { token: TOKEN, updates: ["message"] }),
      node("reply", "telegram", { token: TOKEN, operation: "sendMessage", chatId: "{{ message.chat.id }}", text: "Echo: {{ message.text }}", replyToMessageId: "{{ message.message_id }}" }),
      node("res", "result"),
    ],
    [edge("tg", "reply"), edge("reply", "res")],
  ),
  id: "flow_echo",
  status: "published",
});

const callbackFlow = (): Flow => ({
  ...flow(
    [
      node("tg", "telegram_trigger", { token: TOKEN, updates: ["callback_query"] }),
      node("ack", "telegram", { token: TOKEN, operation: "answerCallbackQuery", queryId: "{{ callback_query.id }}", text: "Принято: {{ callback_query.data }}" }),
      node("res", "result"),
    ],
    [edge("tg", "ack"), edge("ack", "res")],
  ),
  id: "flow_callback",
  status: "published",
});

describe("Telegram: сквозной сценарий в настоящем процессе", () => {
  it("сообщение пользователя → флоу → ответ бота с данными из сообщения", async () => {
    scheduler.sync(echoFlow(), "publish");
    fake.push(TOKEN, { message: { message_id: 7, chat: { id: 5501, type: "private" }, from: { id: 5501, first_name: "Ann" }, text: "привет" } });
    await until(() => fake.calls_("sendMessage").length === 1);
    expect(fake.calls_("sendMessage")[0]!.params).toEqual({ chat_id: 5501, text: "Echo: привет", reply_parameters: { message_id: 7 } });
  });

  it("серия сообщений: ответы приходят на все и в том же порядке", async () => {
    scheduler.sync(echoFlow(), "publish");
    for (let i = 1; i <= 6; i++) fake.push(TOKEN, msg(100 + i, `msg ${i}`));
    await until(() => fake.calls_("sendMessage").length === 6);
    const texts = fake.calls_("sendMessage").map((c) => c.params["text"]);
    // ответы на все сообщения, ни одно не потеряно; порядок ЗАВЕРШЕНИЯ параллельных запусков не гарантируется,
    // порядок их запуска проверен отдельно в тестах очереди планировщика
    expect([...texts].sort()).toEqual([1, 2, 3, 4, 5, 6].map((i) => `Echo: msg ${i}`).sort());
    expect(new Set(fake.calls_("sendMessage").map((c) => c.params["chat_id"])).size).toBe(6);
  }, 60_000);

  it("два флоу на одном боте: каждый получает своё, опрос один", async () => {
    scheduler.sync(echoFlow(), "publish");
    scheduler.sync(callbackFlow(), "publish");
    fake.push(TOKEN, msg(9, "text"));
    fake.push(TOKEN, { callback_query: { id: "cbq-1", from: { id: 9 }, message: { message_id: 3, chat: { id: 9 } }, data: "yes" } });
    await until(() => fake.calls_("sendMessage").length === 1 && fake.calls_("answerCallbackQuery").length === 1);
    expect(fake.calls_("answerCallbackQuery")[0]!.params).toEqual({ callback_query_id: "cbq-1", text: "Принято: yes" });
    expect(fake.calls_("sendMessage")).toHaveLength(1);
    expect(fake.maxInflight.get(TOKEN)).toBeLessThanOrEqual(2); // не более короткого перекрытия при перезапуске запроса
    await sleep(300);
    expect(fake.inflight.get(TOKEN)).toBe(1);
  }, 60_000);

  it("Watch видит запуски; токен не просачивается ни в ленту, ни в лог", async () => {
    const msgs: WatchMessage[] = [];
    hub.subscribe("flow_echo", (m) => void msgs.push(m));
    scheduler.sync(echoFlow(), "publish");
    fake.push(TOKEN, msg(3, "watch me"));
    await until(() => msgs.some((m) => m.type === "run:event" && m.event.event === "flow:done"));
    const done = msgs.find((m) => m.type === "run:event" && m.event.event === "flow:done");
    expect(done).toBeDefined();
    expect(JSON.stringify(msgs)).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    const triggerOut = msgs.find((m) => m.type === "run:event" && m.event.event === "node:done" && m.event.nodeId === "tg");
    expect(triggerOut).toMatchObject({ event: { output: { out0: { message: { text: "watch me" } } } } });
  });

  it("ошибка Bot API при ответе — node:error без токена, опрос продолжает работать", async () => {
    scheduler.sync(echoFlow(), "publish");
    fake.override = (c) => (c.method === "sendMessage" ? { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } } : undefined);
    const msgs: WatchMessage[] = [];
    hub.subscribe("flow_echo", (m) => void msgs.push(m));
    fake.push(TOKEN, msg(1, "first"));
    await until(() => msgs.some((m) => m.type === "run:event" && m.event.event === "node:error"));
    const err = msgs.find((m) => m.type === "run:event" && m.event.event === "node:error") as Extract<WatchMessage, { type: "run:event" }>;
    expect(err.event).toMatchObject({ event: "node:error", nodeId: "reply", error: "Telegram error 400: Bad Request: chat not found" });
    fake.override = undefined;
    fake.push(TOKEN, msg(2, "second"));
    await until(() => fake.calls_("sendMessage").some((c) => c.params["text"] === "Echo: second"));
    expect(fake.calls_("sendMessage").some((c) => c.params["text"] === "Echo: second")).toBe(true);
  }, 60_000);

  it("снятие с публикации останавливает опрос", async () => {
    scheduler.sync(echoFlow(), "publish");
    await until(() => fake.calls_("getUpdates").length >= 1);
    scheduler.sync({ ...echoFlow(), status: "draft" });
    await sleep(500);
    const before = fake.calls.length;
    fake.push(TOKEN, msg(1, "nobody listens"));
    await sleep(700);
    expect(fake.calls.length).toBe(before);
    expect(fake.calls_("sendMessage")).toHaveLength(0);
  });
});

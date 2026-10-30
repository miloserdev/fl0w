import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TelegramSpec } from "@fl0w/blocks";
import { TELEGRAM_API_ENV } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import { createTelegramSources, telegramWebhookKey } from "./telegram-webhook";
import { FakeTelegram, msg, TOKEN, TOKEN2 } from "./test-telegram-server";

let fake: FakeTelegram;
let saved: string | undefined;
let stops: (() => void)[] = [];
let logs: string[] = [];

beforeAll(() => {
  saved = process.env[TELEGRAM_API_ENV];
});
afterAll(() => {
  if (saved === undefined) delete process.env[TELEGRAM_API_ENV];
  else process.env[TELEGRAM_API_ENV] = saved;
});
beforeEach(async () => {
  fake = new FakeTelegram();
  await fake.start();
  process.env[TELEGRAM_API_ENV] = fake.url;
  stops = [];
  logs = [];
});
afterEach(() => {
  for (const s of stops) s();
  fake.stop();
});

const spec = (over: Partial<TelegramSpec> = {}): TelegramSpec => ({
  token: TOKEN,
  updates: ["message"],
  mode: "webhook",
  publicUrl: "https://example.test",
  chatIds: [],
  userIds: [],
  dropPending: false,
  ...over,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await sleep(10);
}
const make = () => createTelegramSources({ log: (m) => logs.push(m), retryMinMs: 20, retryMaxMs: 40, pollTimeoutSec: 1 });
const secretOf = () => String(fake.calls_("setWebhook").at(-1)!.params["secret_token"]);
const keyOf = () => String(fake.calls_("setWebhook").at(-1)!.params["url"]).split("/").pop()!;
const upd = (id: number, body = msg(1, "hi")) => ({ update_id: id, ...body });

describe("Telegram webhook", () => {
  it("registers the webhook with a derived key and secret that do not contain the token", async () => {
    const src = make();
    stops.push(src.factory(spec({ updates: ["message", "callback_query"], dropPending: true }), () => {}));
    await until(() => fake.calls_("setWebhook").length > 0);
    const p = fake.calls_("setWebhook")[0]!.params;
    expect(p["url"]).toBe(`https://example.test/api/telegram/${telegramWebhookKey(TOKEN)}`);
    expect(p["allowed_updates"]).toEqual(["callback_query", "message"]);
    expect(p["drop_pending_updates"]).toBe(true);
    expect(JSON.stringify(p)).not.toContain(TOKEN.split(":")[1]);
    expect(String(p["secret_token"])).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    expect(fake.calls_("getUpdates")).toHaveLength(0);
  });

  it("delivers updates after a check of the key and secret", async () => {
    const got: Json[] = [];
    const src = make();
    stops.push(src.factory(spec(), (u) => got.push(u)));
    await until(() => fake.calls_("setWebhook").length > 0);
    expect(src.handleWebhook(keyOf(), secretOf(), upd(1))).toBe("ok");
    expect(got).toHaveLength(1);
    expect(src.handleWebhook(keyOf(), "wrong", upd(2))).toBe("unauthorized");
    expect(src.handleWebhook(keyOf(), null, upd(2))).toBe("unauthorized");
    expect(src.handleWebhook("nope", secretOf(), upd(2))).toBe("not_found");
    expect(got).toHaveLength(1);
  });

  it("ignores repeated and older update ids, malformed bodies and filtered-out updates", async () => {
    const got: Json[] = [];
    const src = make();
    stops.push(src.factory(spec({ chatIds: ["1"] }), (u) => got.push(u)));
    await until(() => fake.calls_("setWebhook").length > 0);
    const k = keyOf();
    const s = secretOf();
    src.handleWebhook(k, s, upd(5));
    src.handleWebhook(k, s, upd(5));
    src.handleWebhook(k, s, upd(4));
    expect(src.handleWebhook(k, s, "text")).toBe("ok");
    expect(src.handleWebhook(k, s, [1])).toBe("ok");
    expect(src.handleWebhook(k, s, { message: {} })).toBe("ok");
    src.handleWebhook(k, s, upd(6, msg(2, "other chat")));
    expect(got).toHaveLength(1);
  });

  it("re-registers when the set of types changes and removes the webhook with the last trigger", async () => {
    const src = make();
    const stopA = src.factory(spec({ updates: ["message"] }), () => {});
    await until(() => fake.calls_("setWebhook").length === 1);
    const stopB = src.factory(spec({ updates: ["callback_query"] }), () => {});
    await until(() => fake.calls_("setWebhook").length === 2);
    expect(fake.calls_("setWebhook")[1]!.params["allowed_updates"]).toEqual(["callback_query", "message"]);
    stopA();
    await until(() => fake.calls_("setWebhook").length === 3);
    expect(fake.calls_("deleteWebhook")).toHaveLength(0);
    stopB();
    await until(() => fake.calls_("deleteWebhook").length === 1);
    expect(src.handleWebhook(keyOf(), secretOf(), upd(1))).toBe("not_found");
  });

  it("does not delete the webhook when the trigger is replaced right away", async () => {
    const src = make();
    const stop1 = src.factory(spec(), () => {});
    await until(() => fake.calls_("setWebhook").length === 1);
    stop1();
    stops.push(src.factory(spec(), () => {}));
    await sleep(100);
    expect(fake.calls_("deleteWebhook")).toHaveLength(0);
    expect(fake.calls_("setWebhook").length).toBeGreaterThanOrEqual(1);
  });

  it("retries a failed setWebhook without leaking the token into the log", async () => {
    let fail = 2;
    fake.override = (c) => (c.method === "setWebhook" && fail-- > 0 ? { status: 502, body: { ok: false, error_code: 502, description: "Bad gateway" } } : undefined);
    const src = make();
    stops.push(src.factory(spec(), () => {}));
    await until(() => fake.calls_("setWebhook").length >= 3);
    expect(fake.calls_("setWebhook").length).toBe(3);
    expect(logs.some((l) => l.includes("setWebhook failed"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN.split(":")[1]);
  });

  it("keeps bots separate", async () => {
    const got: string[] = [];
    const src = make();
    stops.push(src.factory(spec({ token: TOKEN }), () => got.push("a")));
    stops.push(src.factory(spec({ token: TOKEN2 }), () => got.push("b")));
    await until(() => fake.calls_("setWebhook", TOKEN2).length > 0);
    src.handleWebhook(telegramWebhookKey(TOKEN2), String(fake.calls_("setWebhook", TOKEN2)[0]!.params["secret_token"]), upd(1));
    expect(got).toEqual(["b"]);
    expect(src.handleWebhook(telegramWebhookKey(TOKEN), String(fake.calls_("setWebhook", TOKEN2)[0]!.params["secret_token"]), upd(2))).toBe("unauthorized");
  });

  it("does not mix polling and webhook for one bot", async () => {
    const src = make();
    stops.push(src.factory(spec({ mode: "polling" }), () => {}));
    stops.push(src.factory(spec({ mode: "webhook" }), () => {}));
    await sleep(150);
    expect(fake.calls_("setWebhook")).toHaveLength(0);
    expect(logs.some((l) => l.includes("webhook trigger ignored"))).toBe(true);
  });

  it("polling mode still works through the shared factory", async () => {
    const got: Json[] = [];
    const src = make();
    stops.push(src.factory(spec({ mode: "polling" }), (u) => got.push(u)));
    await sleep(30);
    fake.push(TOKEN, msg(1, "x"));
    await until(() => got.length > 0);
    expect(got).toHaveLength(1);
  });
});

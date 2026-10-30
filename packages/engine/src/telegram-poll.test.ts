import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TelegramSpec } from "@fl0w/blocks";
import { TELEGRAM_API_ENV } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import { createTelegramPoller, updateMatches } from "./telegram-poll";
import { FakeTelegram, msg, TOKEN, TOKEN2 } from "./test-telegram-server";

// свой сервер на каждый тест: «хвосты» обработчиков прошлого теста не должны портить счётчики следующего
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

const spec = (over: Partial<TelegramSpec> = {}): TelegramSpec => ({ token: TOKEN, updates: ["message"], chatIds: [], userIds: [], dropPending: false, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await sleep(15);
}
const poller = () => createTelegramPoller({ pollTimeoutSec: 1, retryMinMs: 30, retryMaxMs: 120, unauthorizedWaitMs: 80, conflictWaitMs: 80, log: (m) => logs.push(m) });
function subscribe(factory: ReturnType<typeof poller>, s: TelegramSpec) {
  const got: Json[] = [];
  stops.push(factory(s, (u) => void got.push(u)));
  return got;
}
const ids = (got: Json[]) => got.map((u) => (u as { update_id: number }).update_id);

describe("updateMatches", () => {
  const upd = (body: Record<string, Json>) => ({ update_id: 1, ...body });
  it("тип обновления", () => {
    expect(updateMatches(spec(), upd(msg(1, "x")))).toBe(true);
    expect(updateMatches(spec({ updates: ["callback_query"] }), upd(msg(1, "x")))).toBe(false);
    expect(updateMatches(spec({ updates: ["*"] }), upd(msg(1, "x")))).toBe(true);
  });
  it("«*» не включает chat_member, message_reaction, message_reaction_count; явное указание — включает", () => {
    for (const k of ["chat_member", "message_reaction", "message_reaction_count"]) {
      expect(updateMatches(spec({ updates: ["*"] }), upd({ [k]: { chat: { id: 1 } } })), k).toBe(false);
      expect(updateMatches(spec({ updates: [k] }), upd({ [k]: { chat: { id: 1 } } })), k).toBe(true);
    }
  });
  it("ограничения по чатам и пользователям, включая callback_query.message.chat", () => {
    const cb = upd({ callback_query: { id: "q", from: { id: 42 }, message: { chat: { id: -100 } }, data: "d" } });
    const s = (o: Partial<TelegramSpec>) => spec({ updates: ["callback_query"], ...o });
    expect(updateMatches(s({ chatIds: ["-100"] }), cb)).toBe(true);
    expect(updateMatches(s({ chatIds: ["5"] }), cb)).toBe(false);
    expect(updateMatches(s({ userIds: ["42"] }), cb)).toBe(true);
    expect(updateMatches(s({ userIds: ["43"] }), cb)).toBe(false);
    expect(updateMatches(s({ chatIds: ["-100"], userIds: ["43"] }), cb)).toBe(false); // оба условия
  });
  it("обновление без чата не проходит ограничение по чатам; пустое обновление — не подходит", () => {
    expect(updateMatches(spec({ updates: ["inline_query"], chatIds: ["1"] }), upd({ inline_query: { id: "i", from: { id: 1 }, query: "q" } }))).toBe(false);
    expect(updateMatches(spec({ updates: ["inline_query"] }), upd({ inline_query: { id: "i", from: { id: 1 }, query: "q" } }))).toBe(true);
    expect(updateMatches(spec(), { update_id: 5 })).toBe(false);
  });
});

describe("createTelegramPoller", () => {
  it("доставляет обновления по порядку и подтверждает их offset'ом — повторов нет", async () => {
    const got = subscribe(poller(), spec());
    const a = fake.push(TOKEN, msg(1, "one"));
    const b = fake.push(TOKEN, msg(1, "two"));
    await until(() => got.length === 2);
    const c = fake.push(TOKEN, msg(1, "three"));
    await until(() => got.length === 3);
    await sleep(150);
    expect(ids(got)).toEqual([a, b, c]);
    const offsets = fake.calls_("getUpdates").map((x) => x.params["offset"]);
    expect(offsets[0]).toBeUndefined();
    expect(offsets.at(-1)).toBe(c + 1); // последнее подтверждено
  });

  it("запрашивает только нужные типы; несколько подписчиков — объединение", async () => {
    const f = poller();
    subscribe(f, spec({ updates: ["message"] }));
    subscribe(f, spec({ updates: ["callback_query", "chat_member"] }));
    await until(() => fake.calls_("getUpdates").length >= 1);
    const allowed = fake.calls_("getUpdates")[0]!.params["allowed_updates"] as string[];
    expect([...allowed].sort()).toEqual(["callback_query", "chat_member", "message"]);
    const star = poller();
    subscribe(star, spec({ token: TOKEN2, updates: ["*"] }));
    await until(() => fake.calls_("getUpdates", TOKEN2).length >= 1);
    const all = fake.calls_("getUpdates", TOKEN2)[0]!.params["allowed_updates"] as string[];
    expect(all).toContain("message");
    expect(all).toContain("callback_query");
    expect(all).not.toContain("chat_member");
  });

  it("подписчики одного токена делят ОДИН опрос и получают каждый своё", async () => {
    const f = poller();
    const messages = subscribe(f, spec({ updates: ["message"] }));
    const callbacks = subscribe(f, spec({ updates: ["callback_query"] }));
    const everything = subscribe(f, spec({ updates: ["message", "callback_query"] }));
    const m = fake.push(TOKEN, msg(1, "hi"));
    const c = fake.push(TOKEN, { callback_query: { id: "q", from: { id: 1 }, message: { chat: { id: 1 } }, data: "d" } });
    await until(() => everything.length === 2);
    expect(ids(messages)).toEqual([m]);
    expect(ids(callbacks)).toEqual([c]);
    expect(ids(everything)).toEqual([m, c]);
    expect(fake.maxInflight.get(TOKEN)).toBe(1); // Telegram допускает одного потребителя getUpdates
  });

  it("подписчик с новыми типами обновлений ПОЗЖЕ: висящий запрос перезапускается и получает их сразу", async () => {
    const f = poller();
    const messages = subscribe(f, spec({ updates: ["message"] }));
    await until(() => (fake.inflight.get(TOKEN) ?? 0) === 1);
    fake.maxWaitMs = 5000; // запрос реально висит долго — без перезапуска второй подписчик ждал бы его конец
    const t0 = Date.now();
    const callbacks = subscribe(f, spec({ updates: ["callback_query"] }));
    await until(() => fake.calls_("getUpdates").some((c) => (c.params["allowed_updates"] as string[]).includes("callback_query")), 1500);
    const union = fake.calls_("getUpdates").find((c) => (c.params["allowed_updates"] as string[]).includes("callback_query"))!;
    expect([...(union.params["allowed_updates"] as string[])].sort()).toEqual(["callback_query", "message"]);
    expect(Date.now() - t0).toBeLessThan(1500);
    const c = fake.push(TOKEN, { callback_query: { id: "q", from: { id: 1 }, message: { chat: { id: 1 } }, data: "d" } });
    await until(() => callbacks.length === 1, 1500);
    expect(ids(callbacks)).toEqual([c]);
    expect(messages).toEqual([]);
    await until(() => (fake.inflight.get(TOKEN) ?? 0) === 1, 1500);
    expect(fake.inflight.get(TOKEN)).toBe(1); // оборванный запрос не остаётся висеть: в итоге ровно один опрос
  });

  it("уход подписчика сужает набор типов (следующий запрос без лишних)", async () => {
    const f = poller();
    subscribe(f, spec({ updates: ["message"] }));
    subscribe(f, spec({ updates: ["callback_query"] }));
    await until(() => fake.calls_("getUpdates").length >= 1);
    stops[1]!();
    await until(() => fake.calls_("getUpdates").some((c) => (c.params["allowed_updates"] as string[]).length === 1), 1500);
    expect(fake.calls_("getUpdates").at(-1)!.params["allowed_updates"]).toEqual(["message"]);
  });

  it("ограничения по чатам и пользователям работают на подписчике", async () => {
    const f = poller();
    const onlyChat2 = subscribe(f, spec({ chatIds: ["2"] }));
    const anyone = subscribe(f, spec());
    fake.push(TOKEN, msg(1, "from chat 1"));
    const x = fake.push(TOKEN, msg(2, "from chat 2"));
    await until(() => anyone.length === 2);
    expect(ids(onlyChat2)).toEqual([x]);
  });

  it("разные токены — разные независимые опросы", async () => {
    const f = poller();
    const a = subscribe(f, spec());
    const b = subscribe(f, spec({ token: TOKEN2 }));
    const ida = fake.push(TOKEN, msg(1, "a"));
    const idb = fake.push(TOKEN2, msg(1, "b"));
    await until(() => a.length === 1 && b.length === 1);
    expect(ids(a)).toEqual([ida]);
    expect(ids(b)).toEqual([idb]);
  });

  it("отписка последнего подписчика обрывает висящий запрос и останавливает опрос; отписка одного — нет", async () => {
    const f = poller();
    const first = subscribe(f, spec());
    const second = subscribe(f, spec());
    await until(() => (fake.inflight.get(TOKEN) ?? 0) === 1);
    stops[0]!();
    const id = fake.push(TOKEN, msg(1, "still polled"));
    await until(() => second.length === 1);
    expect(ids(second)).toEqual([id]);
    expect(first).toEqual([]); // отписанный больше не получает
    stops[1]!();
    await until(() => (fake.inflight.get(TOKEN) ?? 0) === 0, 1000);
    expect(fake.inflight.get(TOKEN) ?? 0).toBe(0);
    const before = fake.calls.length;
    await sleep(400);
    expect(fake.calls.length).toBe(before); // запросы прекратились
  });

  it("после полной отписки повторная подписка запускает опрос заново", async () => {
    const f = poller();
    subscribe(f, spec());
    stops.pop()!();
    await sleep(60);
    const got = subscribe(f, spec());
    const id = fake.push(TOKEN, msg(1, "again"));
    await until(() => got.length === 1);
    expect(ids(got)).toEqual([id]);
  });

  it("dropPending: накопленные обновления отбрасываются, новые приходят", async () => {
    fake.push(TOKEN, msg(1, "old 1"));
    fake.push(TOKEN, msg(1, "old 2"));
    fake.push(TOKEN, msg(1, "old 3"));
    const got = subscribe(poller(), spec({ dropPending: true }));
    await until(() => fake.calls_("getUpdates").length >= 2);
    expect(fake.calls_("getUpdates")[0]!.params).toMatchObject({ offset: -1, timeout: 0 });
    const fresh = fake.push(TOKEN, msg(1, "fresh"));
    await until(() => got.length === 1);
    await sleep(100);
    expect(ids(got)).toEqual([fresh]); // старых нет
  });

  it("без dropPending накопленные обновления доставляются", async () => {
    const a = fake.push(TOKEN, msg(1, "old"));
    const got = subscribe(poller(), spec());
    await until(() => got.length === 1);
    expect(ids(got)).toEqual([a]);
  });

  it("сбой подписчика не мешает остальным и не останавливает опрос", async () => {
    const f = poller();
    stops.push(f(spec(), () => {
      throw new Error("boom");
    }));
    const ok = subscribe(f, spec());
    fake.push(TOKEN, msg(1, "1"));
    fake.push(TOKEN, msg(1, "2"));
    await until(() => ok.length === 2);
    expect(ok).toHaveLength(2);
  });

  describe("ошибки и повторы", () => {
    it("неверный токен (401): запись в лог один раз, повтор с паузой, токена в логе нет", async () => {
      fake.override = () => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
      subscribe(poller(), spec());
      await until(() => fake.calls_("getUpdates").length >= 3);
      expect(fake.calls_("getUpdates").length).toBeGreaterThanOrEqual(3);
      const failures = logs.filter((l) => /polling failed/.test(l));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/Telegram error 401: Unauthorized.*токен отклонён|token/i);
      expect(logs.join("\n")).not.toContain(TOKEN);
      expect(logs.join("\n")).toContain("telegram bot 123456");
    });

    it("конфликт (409) подсказывает про вебхук", async () => {
      fake.override = () => ({ status: 409, body: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } });
      subscribe(poller(), spec());
      await until(() => logs.some((l) => /409/.test(l)));
      expect(logs.join("\n")).toMatch(/вебхук/);
    });

    it("временный сбой (500): повторы с нарастающей паузой, затем восстановление и доставка", async () => {
      let failing = true;
      fake.override = (c) => (failing && c.method === "getUpdates" ? { status: 500, body: { ok: false, error_code: 500, description: "Internal" } } : undefined);
      const got = subscribe(poller(), spec());
      const id = fake.push(TOKEN, msg(1, "queued while down"));
      await until(() => fake.calls_("getUpdates").length >= 3);
      expect(got).toEqual([]);
      failing = false;
      await until(() => got.length === 1);
      expect(ids(got)).toEqual([id]);
      expect(logs.some((l) => /polling recovered/.test(l))).toBe(true);
    });

    it("недоступный сервер не роняет опрос", async () => {
      process.env[TELEGRAM_API_ENV] = "http://127.0.0.1:1";
      try {
        subscribe(poller(), spec());
        await until(() => logs.length > 0);
        expect(logs[0]).toMatch(/polling failed: Telegram request failed/);
        expect(logs[0]).not.toContain(TOKEN);
      } finally {
        process.env[TELEGRAM_API_ENV] = fake.url;
      }
    });
  });
});

/** Node-only. Вебхук Telegram для Telegram Trigger (режим webhook) и общая фабрика источников. Экспортируется через `@fl0w/engine/server`. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { callTelegram, TELEGRAM_OPT_IN_UPDATES, TELEGRAM_UPDATE_TYPES, type TelegramSpec } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import type { TelegramPollFactory } from "./scheduler";
import { createTelegramPoller, updateMatches, type TelegramPollerOptions } from "./telegram-poll";

export type TelegramWebhookResult = "ok" | "unauthorized" | "not_found";

export type TelegramWebhookOptions = {
  /** Паузы между повторами setWebhook после сбоя: минимум и максимум, мс. */
  retryMinMs?: number;
  retryMaxMs?: number;
  log?: (msg: string) => void;
};

type Sub = { spec: TelegramSpec; onUpdate: (update: Json) => void };
type Bot = { token: string; key: string; secret: string; subs: Set<Sub>; synced?: string; lastUpdateId: number; retry?: ReturnType<typeof setTimeout> };

const DEFAULT_UPDATES = TELEGRAM_UPDATE_TYPES.filter((t) => !TELEGRAM_OPT_IN_UPDATES.includes(t));

/** Односторонние производные от токена: по ним токен не восстановить, а угадать их без токена нельзя. */
const derive = (token: string, purpose: string) => createHmac("sha256", token).update(`fl0w-telegram-${purpose}`).digest("hex");

const botId = (token: string) => token.split(":")[0]!;

const safeEqual = (a: string, b: string) => {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
};

/** Ключ в адресе вебхука для токена (виден в URL, поэтому не содержит токена). */
export const telegramWebhookKey = (token: string) => derive(token, "key").slice(0, 32);

/**
 * Регистрация вебхука у Telegram (`setWebhook`) и приём обновлений. Адрес — `<publicUrl>/api/telegram/<ключ>`, подлинность
 * запроса проверяется секретным заголовком `X-Telegram-Bot-Api-Secret-Token`. Вызовы к Bot API по одному токену идут по
 * очереди, чтобы быстрая перепубликация не переставила `setWebhook` и `deleteWebhook`.
 */
export function createTelegramWebhooks(opts: TelegramWebhookOptions = {}) {
  const retryMin = opts.retryMinMs ?? 2000;
  const retryMax = opts.retryMaxMs ?? 60_000;
  const log = opts.log ?? (() => {});
  const bots = new Map<string, Bot>();
  const byKey = new Map<string, Bot>();
  const chains = new Map<string, Promise<void>>();

  const enqueue = (token: string, job: () => Promise<void>) => {
    const next = (chains.get(token) ?? Promise.resolve()).then(job, job);
    chains.set(token, next);
    void next.finally(() => chains.get(token) === next && chains.delete(token));
  };

  const wanted = (bot: Bot) => {
    const set = new Set<string>();
    for (const s of bot.subs) for (const u of s.spec.updates) (u === "*" ? DEFAULT_UPDATES : [u]).forEach((x) => set.add(x));
    return [...set].sort();
  };

  const sync = (bot: Bot, backoff = retryMin) => {
    clearTimeout(bot.retry);
    enqueue(bot.token, async () => {
      if (bots.get(bot.token) !== bot) return; // за время ожидания в очереди все подписчики ушли
      const allowed = wanted(bot);
      const signature = allowed.join(",");
      if (bot.synced === signature) return;
      const publicUrl = [...bot.subs][0]!.spec.publicUrl;
      try {
        await callTelegram(
          bot.token,
          "setWebhook",
          {
            url: `${publicUrl}/api/telegram/${bot.key}`,
            secret_token: bot.secret,
            allowed_updates: allowed,
            drop_pending_updates: bot.synced === undefined && [...bot.subs].some((s) => s.spec.dropPending),
          },
          { timeoutMs: 15_000 },
        );
        bot.synced = signature;
        log(`telegram bot ${botId(bot.token)}: webhook registered for ${allowed.join(", ")}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`telegram bot ${botId(bot.token)}: setWebhook failed: ${message}; retry in ${Math.round(backoff / 1000)} s`);
        bot.retry = setTimeout(() => bots.get(bot.token) === bot && sync(bot, Math.min(backoff * 2, retryMax)), backoff);
      }
    });
  };

  const subscribe = (spec: TelegramSpec, onUpdate: (update: Json) => void): (() => void) => {
    const sub: Sub = { spec, onUpdate };
    let bot = bots.get(spec.token);
    if (!bot) {
      bot = { token: spec.token, key: telegramWebhookKey(spec.token), secret: derive(spec.token, "secret"), subs: new Set(), lastUpdateId: -1 };
      bots.set(spec.token, bot);
      byKey.set(bot.key, bot);
    }
    bot.subs.add(sub);
    sync(bot);
    const mine = bot;
    return () => {
      mine.subs.delete(sub);
      if (mine.subs.size > 0) return sync(mine);
      clearTimeout(mine.retry);
      if (bots.get(mine.token) === mine) bots.delete(mine.token);
      byKey.delete(mine.key);
      if (mine.synced === undefined) return; // вебхук не регистрировали — снимать нечего
      enqueue(mine.token, async () => {
        if (bots.has(mine.token)) return; // тем временем подписались снова — вебхук нужен
        try {
          await callTelegram(mine.token, "deleteWebhook", {}, { timeoutMs: 15_000 });
          log(`telegram bot ${botId(mine.token)}: webhook removed`);
        } catch (e) {
          log(`telegram bot ${botId(mine.token)}: deleteWebhook failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    };
  };

  /** Входящий запрос от Telegram: проверка ключа и секрета, отсев повторов, раздача подписчикам. */
  const handleWebhook = (key: string, secretHeader: string | null, update: unknown): TelegramWebhookResult => {
    const bot = byKey.get(key);
    if (!bot) return "not_found";
    if (secretHeader === null || !safeEqual(secretHeader, bot.secret)) return "unauthorized";
    if (update === null || typeof update !== "object" || Array.isArray(update)) return "ok";
    const obj = update as { [k: string]: Json };
    const id = obj["update_id"];
    if (typeof id !== "number") return "ok";
    if (id <= bot.lastUpdateId) return "ok"; // Telegram повторяет доставку, если ответ не успел
    bot.lastUpdateId = id;
    for (const sub of [...bot.subs]) {
      if (!updateMatches(sub.spec, obj)) continue;
      try {
        sub.onUpdate(obj);
      } catch {
        // сломанный подписчик не должен останавливать раздачу остальным
      }
    }
    return "ok";
  };

  return { subscribe, handleWebhook, active: (token: string) => bots.has(token) };
}

/**
 * Общая фабрика источников Telegram: по `mode` подписка идёт через опрос или вебхук. У одного бота одновременно
 * возможен только один способ (Telegram не отдаёт getUpdates при активном вебхуке) — второй получает пустую подписку и запись в лог.
 */
export function createTelegramSources(opts: TelegramPollerOptions & TelegramWebhookOptions = {}) {
  const log = opts.log ?? (() => {});
  const poller = createTelegramPoller(opts);
  const webhooks = createTelegramWebhooks(opts);
  const modes = new Map<string, { mode: string; count: number }>();

  const factory: TelegramPollFactory = (spec, onUpdate) => {
    const current = modes.get(spec.token);
    if (current && current.mode !== spec.mode) {
      log(`telegram bot ${botId(spec.token)}: ${spec.mode} trigger ignored — the bot is already used in ${current.mode} mode by another trigger`);
      return () => {};
    }
    const entry = current ?? { mode: spec.mode, count: 0 };
    entry.count++;
    modes.set(spec.token, entry);
    const stop = spec.mode === "webhook" ? webhooks.subscribe(spec, onUpdate) : poller(spec, onUpdate);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      stop();
      if (--entry.count === 0) modes.delete(spec.token);
    };
  };

  return { factory, handleWebhook: webhooks.handleWebhook };
}

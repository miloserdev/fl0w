/** Node-only. Опрос Bot API (getUpdates) для Telegram Trigger. Экспортируется через `@fl0w/engine/server`. */
import { callTelegram, TELEGRAM_OPT_IN_UPDATES, TELEGRAM_UPDATE_TYPES, TelegramError, type TelegramSpec } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import type { TelegramPollFactory } from "./scheduler";

export type TelegramPollerOptions = {
  /** Длительность одного long-poll запроса, с. */
  pollTimeoutSec?: number;
  /** Паузы между повторами после сбоя: минимум и максимум, мс (растёт вдвое). */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Паузы для «известных» отказов: неверный токен (401) и конфликт опроса/вебхука (409), мс. */
  unauthorizedWaitMs?: number;
  conflictWaitMs?: number;
  log?: (msg: string) => void;
};

type Sub = { spec: TelegramSpec; onUpdate: (update: Json) => void };
type Bot = {
  token: string;
  subs: Set<Sub>;
  /** Остановка всего опроса (последний подписчик ушёл). */
  abort: AbortController;
  /** Остановка только текущего запроса — когда изменился набор нужных типов обновлений. */
  restart: AbortController;
  /** allowed_updates текущего запроса — чтобы заметить, что набор изменился. */
  requested?: string;
  offset?: number;
};

const DEFAULT_UPDATES = TELEGRAM_UPDATE_TYPES.filter((t) => !TELEGRAM_OPT_IN_UPDATES.includes(t));

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** Идентификатор бота для логов (часть токена до двоеточия) — сам токен в логи не попадает. */
const botId = (token: string) => token.split(":")[0]!;

const asObject = (v: Json | undefined): { [k: string]: Json } | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;

/** id чата и пользователя из обновления: у разных типов они лежат в разных местах. */
function actors(update: { [k: string]: Json }, key: string) {
  const body = asObject(update[key]);
  const inner = asObject(body?.["message"]); // callback_query.message
  const chat = asObject(body?.["chat"]) ?? asObject(inner?.["chat"]);
  const user = asObject(body?.["from"]) ?? asObject(body?.["user"]);
  return { chatId: chat?.["id"] !== undefined ? String(chat["id"]) : null, userId: user?.["id"] !== undefined ? String(user["id"]) : null };
}

/** Подходит ли обновление подписке: тип, затем ограничения по чатам и пользователям. */
export function updateMatches(spec: TelegramSpec, update: { [k: string]: Json }): boolean {
  const key = Object.keys(update).find((k) => k !== "update_id");
  if (!key) return false;
  const typeOk = spec.updates.includes(key) || (spec.updates.includes("*") && !TELEGRAM_OPT_IN_UPDATES.includes(key));
  if (!typeOk) return false;
  const { chatId, userId } = actors(update, key);
  const chats = spec.chatIds.map((c) => c.toLowerCase());
  if (chats.length > 0 && (chatId === null || !chats.includes(chatId.toLowerCase()))) return false;
  if (spec.userIds.length > 0 && (userId === null || !spec.userIds.includes(userId))) return false;
  return true;
}

/**
 * Один опрос на токен, раздача обновлений всем подписчикам этого бота. Telegram позволяет только одному
 * потребителю читать getUpdates, поэтому несколько триггеров с одним токеном делят цикл. Подтверждение обновлений —
 * через offset на следующем запросе (после раздачи), поэтому при падении сервера необработанное не теряется.
 */
export function createTelegramPoller(opts: TelegramPollerOptions = {}): TelegramPollFactory {
  const pollSec = opts.pollTimeoutSec ?? 25;
  const retryMin = opts.retryMinMs ?? 1000;
  const retryMax = opts.retryMaxMs ?? 30_000;
  const log = opts.log ?? (() => {});
  const bots = new Map<string, Bot>();

  const wantedUpdates = (bot: Bot): string[] => {
    const wanted = new Set<string>();
    for (const s of bot.subs) for (const u of s.spec.updates) (u === "*" ? DEFAULT_UPDATES : [u]).forEach((x) => wanted.add(x));
    return [...wanted];
  };

  const dispatch = (bot: Bot, update: Json) => {
    const obj = asObject(update);
    if (!obj) return;
    for (const sub of [...bot.subs]) {
      if (!updateMatches(sub.spec, obj)) continue;
      try {
        sub.onUpdate(update);
      } catch {
        // сломанный подписчик не должен останавливать раздачу остальным
      }
    }
  };

  /** Набор типов изменился → висящий запрос (со старым allowed_updates) обрываем и начинаем новый. */
  const refresh = (bot: Bot) => {
    if (bot.requested !== undefined && bot.requested !== wantedUpdates(bot).sort().join(",")) bot.restart.abort();
  };

  const loop = async (bot: Bot) => {
    const { signal } = bot.abort;
    let backoff = retryMin;
    let lastError = "";
    let dropChecked = false;
    const id = botId(bot.token);
    while (!signal.aborted) {
      try {
        if (!dropChecked) {
          dropChecked = true;
          if ([...bot.subs].some((s) => s.spec.dropPending)) {
            // последнее обновление: всё накопленное до него отбрасывается подтверждением offset
            const last = await callTelegram(bot.token, "getUpdates", { offset: -1, timeout: 0 }, { signal, timeoutMs: 15_000 });
            const o = Array.isArray(last) ? asObject(last[last.length - 1]) : null;
            if (o && typeof o["update_id"] === "number") bot.offset = o["update_id"] + 1;
            log(`telegram bot ${id}: pending updates dropped`);
          }
        }
        bot.restart = new AbortController();
        const wanted = wantedUpdates(bot).sort();
        bot.requested = wanted.join(",");
        const updates = await callTelegram(
          bot.token,
          "getUpdates",
          { offset: bot.offset, timeout: pollSec, allowed_updates: wanted },
          { signal: AbortSignal.any([signal, bot.restart.signal]), timeoutMs: (pollSec + 15) * 1000 },
        );
        if (lastError) log(`telegram bot ${id}: polling recovered`);
        lastError = "";
        backoff = retryMin;
        for (const u of Array.isArray(updates) ? updates : []) {
          const o = asObject(u);
          if (typeof o?.["update_id"] === "number") bot.offset = o["update_id"] + 1;
          dispatch(bot, u);
        }
      } catch (e) {
        if (signal.aborted) return;
        if (bot.restart.signal.aborted) continue; // смена набора типов: сразу новый запрос, без паузы и записи в лог
        const message = e instanceof Error ? e.message : String(e);
        let wait = backoff;
        if (e instanceof TelegramError && e.code === 401) wait = opts.unauthorizedWaitMs ?? 60_000;
        else if (e instanceof TelegramError && e.code === 409) wait = opts.conflictWaitMs ?? 30_000;
        else if (e instanceof TelegramError && e.retryAfter) wait = e.retryAfter * 1000;
        else backoff = Math.min(backoff * 2, retryMax);
        if (message !== lastError) {
          lastError = message;
          const hint =
            e instanceof TelegramError && e.code === 409
              ? " — у бота активен вебхук или getUpdates уже опрашивает другой клиент"
              : e instanceof TelegramError && e.code === 401
                ? " — токен отклонён"
                : "";
          log(`telegram bot ${id}: polling failed: ${message}${hint}; retry in ${Math.round(wait / 1000)} s`);
        }
        await sleep(wait, signal);
      }
    }
  };

  return (spec, onUpdate) => {
    const sub: Sub = { spec, onUpdate };
    let bot = bots.get(spec.token);
    if (!bot) {
      bot = { token: spec.token, subs: new Set(), abort: new AbortController(), restart: new AbortController() };
      bots.set(spec.token, bot);
      bot.subs.add(sub);
      // старт отложен на микрозадачу: подписчики, пришедшие в том же такте, попадут в первый же запрос
      const first = bot;
      queueMicrotask(() => void loop(first));
    } else {
      bot.subs.add(sub);
      refresh(bot);
    }

    const mine = bot;
    return () => {
      mine.subs.delete(sub);
      if (mine.subs.size === 0) {
        mine.abort.abort(); // обрывает и висящий long-poll запрос
        if (bots.get(spec.token) === mine) bots.delete(spec.token);
      } else refresh(mine);
    };
  };
}

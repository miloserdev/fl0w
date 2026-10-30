import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext, type TelegramSpec } from "./block";
import { stringList } from "./list-utils";
import { resolveSecret } from "./secrets";
import { TELEGRAM_TOKEN_ENV } from "./telegram";
import { TELEGRAM_API_ENV, assertToken } from "./telegram-api";

/** Типы обновлений Bot API (поле Update). */
export const TELEGRAM_UPDATE_TYPES = [
  "message", "edited_message", "channel_post", "edited_channel_post", "business_connection", "business_message",
  "edited_business_message", "deleted_business_messages", "message_reaction", "message_reaction_count", "inline_query",
  "chosen_inline_result", "callback_query", "shipping_query", "pre_checkout_query", "purchased_paid_media", "poll",
  "poll_answer", "my_chat_member", "chat_member", "chat_join_request", "chat_boost", "removed_chat_boost",
];
/** Эти три Telegram не присылает по умолчанию («*» их не включает): они дают очень много обновлений. */
export const TELEGRAM_OPT_IN_UPDATES = ["chat_member", "message_reaction", "message_reaction_count"];

/** Публичный адрес сервера для вебхука Telegram: именно по нему Telegram будет присылать обновления. */
export const PUBLIC_URL_ENV = "FL0W_PUBLIC_URL";

function publicUrl(): string {
  const raw = process.env[PUBLIC_URL_ENV]?.trim();
  if (!raw) {
    throw new Error(`Telegram Trigger in webhook mode needs ${PUBLIC_URL_ENV} — the public https address of this server (for example https://abc.ngrok.app)`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${PUBLIC_URL_ENV} is not a valid URL`);
  }
  // Telegram принимает вебхуки только по https; http допускается лишь при своём Bot API (FL0W_TELEGRAM_API) — для тестов
  if (u.protocol !== "https:" && !(u.protocol === "http:" && process.env[TELEGRAM_API_ENV])) {
    throw new Error(`${PUBLIC_URL_ENV} must be an https URL (Telegram sends webhooks only over https)`);
  }
  if (u.search || u.hash) throw new Error(`${PUBLIC_URL_ENV} must not contain a query or fragment`);
  return raw.replace(/\/+$/, "");
}

const idList = (raw: Json | undefined, name: string, allowNames: boolean): string[] =>
  stringList(raw, name).map((v) => {
    if (/^-?\d+$/.test(v) || (allowNames && /^@[A-Za-z0-9_]{3,}$/.test(v))) return v;
    throw new Error(`Telegram Trigger: "${v}" in ${name} is not a valid ${allowNames ? "chat id or @username" : "user id"}`);
  });

/**
 * Telegram Trigger: запускает флоу на обновления бота (сообщения, нажатия кнопок, inline-запросы и т.д.).
 * Работает у опубликованного флоу. Два способа получения (`mode`): `polling` — сервер сам опрашивает `getUpdates`
 * (только исходящие запросы, ничего публиковать не нужно); `webhook` — как в n8n: при публикации регистрируется вебхук
 * (`setWebhook`), Telegram присылает обновления на `<FL0W_PUBLIC_URL>/api/telegram/<ключ>` мгновенно, запрос проверяется
 * секретным заголовком. Вебхуку нужен публичный https-адрес сервера — выставляйте наружу только путь `/api/telegram/`.
 * Выход — объект Update целиком, например `{ update_id, message: { chat: { id }, text, … } }`.
 * Токен — как у блока Telegram (`env:FL0W_SECRET_…`). У бота не должно быть активного вебхука, а опрашивать его может
 * только один потребитель — несколько триггеров с одним токеном разделяют один опрос.
 */
export class TelegramTrigger extends Block {
  static type = "telegram_trigger";
  static label = "Telegram Trigger";
  static icon = "messages-square";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "token", type: "string", default: "" },
    // способ получения: опрос (getUpdates, только исходящие запросы) или вебхук (Telegram присылает сам, нужен FL0W_PUBLIC_URL)
    {
      name: "mode",
      type: "enum",
      default: "polling",
      options: [{ value: "polling" }, { value: "webhook" }],
    },
    // на какие события срабатывать; "*" — все (кроме chat_member, message_reaction, message_reaction_count)
    {
      name: "updates",
      type: "multienum",
      required: true,
      default: ["message"],
      options: ["*", ...TELEGRAM_UPDATE_TYPES].map((value) => ({ value })),
    },
    // ограничения через запятую; пусто — без ограничений
    { name: "chatIds", type: "string", default: "" },
    { name: "userIds", type: "string", default: "" },
    // при запуске сбросить накопившиеся, пока флоу не работал, обновления
    { name: "dropPending", type: "boolean", default: false },
  ];

  static telegram(params: Record<string, Json>): TelegramSpec {
    const token = resolveSecret(params["token"], TELEGRAM_TOKEN_ENV);
    assertToken(token);
    const updates = stringList(params["updates"] ?? ["message"], "updates");
    if (updates.length === 0) throw new Error('Telegram Trigger: choose at least one update type in "updates"');
    for (const u of updates) {
      if (u !== "*" && !TELEGRAM_UPDATE_TYPES.includes(u)) throw new Error(`Telegram Trigger: unknown update type "${u}"`);
    }
    const mode = String(params["mode"] ?? "polling");
    if (mode !== "polling" && mode !== "webhook") throw new Error(`Unknown mode "${mode}"`);
    return {
      token,
      updates,
      mode,
      ...(mode === "webhook" ? { publicUrl: publicUrl() } : {}),
      chatIds: idList(params["chatIds"], "chatIds", true),
      userIds: idList(params["userIds"], "userIds", false),
      dropPending: params["dropPending"] === true,
    };
  }

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return {
      out0: ctx.triggerData ?? {
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: "private", first_name: "Example" },
          from: { id: 123456789, is_bot: false, first_name: "Example" },
          text: "Hello from Telegram",
        },
      },
    };
  }
}

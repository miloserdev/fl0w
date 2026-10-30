import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext, type TelegramSpec } from "./block";
import { stringList } from "./list-utils";
import { resolveSecret } from "./secrets";
import { TELEGRAM_TOKEN_ENV } from "./telegram";
import { assertToken } from "./telegram-api";

/** Типы обновлений Bot API (поле Update). */
export const TELEGRAM_UPDATE_TYPES = [
  "message", "edited_message", "channel_post", "edited_channel_post", "business_connection", "business_message",
  "edited_business_message", "deleted_business_messages", "message_reaction", "message_reaction_count", "inline_query",
  "chosen_inline_result", "callback_query", "shipping_query", "pre_checkout_query", "purchased_paid_media", "poll",
  "poll_answer", "my_chat_member", "chat_member", "chat_join_request", "chat_boost", "removed_chat_boost",
];
/** Эти три Telegram не присылает по умолчанию («*» их не включает): они дают очень много обновлений. */
export const TELEGRAM_OPT_IN_UPDATES = ["chat_member", "message_reaction", "message_reaction_count"];

const idList = (raw: Json | undefined, name: string, allowNames: boolean): string[] =>
  stringList(raw, name).map((v) => {
    if (/^-?\d+$/.test(v) || (allowNames && /^@[A-Za-z0-9_]{3,}$/.test(v))) return v;
    throw new Error(`Telegram Trigger: "${v}" in ${name} is not a valid ${allowNames ? "chat id or @username" : "user id"}`);
  });

/**
 * Telegram Trigger: запускает флоу на обновления бота (сообщения, нажатия кнопок, inline-запросы и т.д.).
 * Работает у опубликованного флоу через long polling (`getUpdates`) — в отличие от n8n, где используется вебхук:
 * вебхуку нужен публичный HTTPS-адрес, а он открыл бы наружу весь неаутентифицированный редактор. Опрос только исходящий.
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
    // ["message", "callback_query"]; "*" — все (кроме chat_member, message_reaction, message_reaction_count)
    { name: "updates", type: "json", default: ["message"] },
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
    return {
      token,
      updates,
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

import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type RunContext, type TelegramSpec } from "./block";
import { stringList } from "./list-utils";
import { resolveSecret } from "./secrets";
import { TELEGRAM_TOKEN_ENV } from "./telegram";
import { TELEGRAM_API_ENV, assertToken } from "./telegram-api";

/** Bot API update types (the Update field). */
export const TELEGRAM_UPDATE_TYPES = [
  "message", "edited_message", "channel_post", "edited_channel_post", "business_connection", "business_message",
  "edited_business_message", "deleted_business_messages", "message_reaction", "message_reaction_count", "inline_query",
  "chosen_inline_result", "callback_query", "shipping_query", "pre_checkout_query", "purchased_paid_media", "poll",
  "poll_answer", "my_chat_member", "chat_member", "chat_join_request", "chat_boost", "removed_chat_boost",
];
/** Telegram does not send these three by default ("*" does not include them): they produce a great many updates. */
export const TELEGRAM_OPT_IN_UPDATES = ["chat_member", "message_reaction", "message_reaction_count"];

/** Public server address for the Telegram webhook: Telegram will send updates exactly to it. */
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
  // Telegram accepts webhooks only over https; http is allowed only with your own Bot API (FL0W_TELEGRAM_API), for tests
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
 * Telegram Trigger: starts a flow on bot updates (messages, button presses, inline queries, etc.).
 * Works for a published flow. Two ways to receive (`mode`): `polling`: the server polls `getUpdates` itself
 * (outgoing requests only, nothing needs to be published); `webhook`: as in n8n, a webhook is registered on publication
 * (`setWebhook`), Telegram sends updates to `<FL0W_PUBLIC_URL>/api/telegram/<key>` instantly, and the request is verified
 * by a secret header. A webhook needs a public https address of the server: expose only the path `/api/telegram/` externally.
 * The output is the whole Update object, for example `{ update_id, message: { chat: { id }, text, ... } }`.
 * The token is the same as for the Telegram block (`env:FL0W_SECRET_...`). The bot must have no active webhook, and only
 * one consumer can poll it: several triggers with one token share a single poll.
 */
export class TelegramTrigger extends Block {
  static type = "telegram_trigger";
  static label = "Telegram Trigger";
  static icon = "messages-square";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "token", type: "string", default: "" },
    // how to receive: polling (getUpdates, outgoing requests only) or a webhook (Telegram sends by itself, needs FL0W_PUBLIC_URL)
    {
      name: "mode",
      type: "enum",
      default: "polling",
      options: [{ value: "polling" }, { value: "webhook" }],
    },
    // which events to fire on; "*" means all (except chat_member, message_reaction, message_reaction_count)
    {
      name: "updates",
      type: "multienum",
      required: true,
      default: ["message"],
      options: ["*", ...TELEGRAM_UPDATE_TYPES].map((value) => ({ value })),
    },
    // restrictions separated by commas; empty means no restrictions
    { name: "chatIds", type: "string", default: "" },
    { name: "userIds", type: "string", default: "" },
    // on start, drop the updates that piled up while the flow was not running
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
    return { out0: triggerPayload(ctx, "Telegram Trigger") };
  }
}

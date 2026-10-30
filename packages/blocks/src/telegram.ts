import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { interpolate, isPlainObject, resolveTemplates } from "./json-path";
import { filesBaseDir, resolveInside } from "./sandbox";
import { redact, resolveSecret } from "./secrets";
import { assertToken, callTelegram, downloadTelegramFile, type TelegramUpload } from "./telegram-api";

export const TELEGRAM_TOKEN_ENV = "FL0W_SECRET_TELEGRAM_BOT_TOKEN";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // предел загрузки файла ботом
const FILE_PREFIX = "file:";

/** Операции Bot API (как в ноде Telegram из n8n), сгруппированные по ресурсам. */
const CHAT = ["getChat", "getChatAdministrators", "getChatMember", "leaveChat", "setChatDescription", "setChatTitle"];
const CALLBACK = ["answerCallbackQuery", "answerInlineQuery"];
const FILE = ["getFile"];
const MESSAGE = [
  "deleteMessage", "editMessageText", "pinChatMessage", "unpinChatMessage", "sendAnimation", "sendAudio",
  "sendChatAction", "sendDocument", "sendLocation", "sendMediaGroup", "sendMessage", "sendPhoto", "sendSticker", "sendVideo",
];
export const TELEGRAM_OPERATIONS = [...CHAT, ...CALLBACK, ...FILE, ...MESSAGE];

/** Отправка файла: имя поля Bot API → нужна ли подпись. */
const MEDIA_FIELD: Record<string, string> = {
  sendPhoto: "photo", sendDocument: "document", sendVideo: "video", sendAudio: "audio", sendAnimation: "animation", sendSticker: "sticker",
};
const WITH_CAPTION = ["sendPhoto", "sendDocument", "sendVideo", "sendAudio", "sendAnimation"];
const SEND = [...Object.keys(MEDIA_FIELD), "sendMessage", "sendLocation", "sendMediaGroup", "sendChatAction"];
const needsChat = (op: string) => !CALLBACK.includes(op) && !FILE.includes(op);

const when = (...ops: string[]) => ({ param: "operation", in: ops });
const CHAT_ACTIONS = [
  "typing", "upload_photo", "record_video", "upload_video", "record_voice", "upload_voice", "upload_document",
  "choose_sticker", "find_location", "record_video_note", "upload_video_note",
];

/**
 * Telegram: действия бота — чаты, сообщения, файлы, ответы на callback/inline-запросы (аналог ноды Telegram из n8n).
 * Токен: `env:FL0W_SECRET_…` (переменная окружения сервера) или литерал; пусто — `FL0W_SECRET_TELEGRAM_BOT_TOKEN`.
 * Поля чата, текста и т.п. поддерживают `{{ путь }}` из входа — например `{{ message.chat.id }}` после Telegram Trigger.
 * Файл для отправки: `file_id`, HTTP-ссылка или `file:путь` внутри каталога файлов (загружается multipart).
 * Результат — `result` ответа Bot API (объект сообщения, чата и т.д.); для операций с ответом `true` — `{ ok: true }`.
 */
export class Telegram extends Block {
  static type = "telegram";
  static label = "Telegram";
  static icon = "send";
  static category = "app";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "token", type: "string", default: "" },
    {
      name: "operation",
      type: "enum",
      required: true,
      default: "sendMessage",
      options: TELEGRAM_OPERATIONS.map((value) => ({ value })),
    },
    { name: "chatId", type: "string", required: true, showWhen: when(...TELEGRAM_OPERATIONS.filter(needsChat)) },
    { name: "messageId", type: "string", required: true, showWhen: when("deleteMessage", "editMessageText", "pinChatMessage", "unpinChatMessage") },
    { name: "userId", type: "string", required: true, showWhen: when("getChatMember") },
    // текст сообщения; для setChatTitle — название, setChatDescription — описание, answerCallbackQuery — текст ответа
    { name: "text", type: "string", multiline: true, showWhen: when("sendMessage", "editMessageText", "setChatTitle", "setChatDescription", "answerCallbackQuery") },
    {
      name: "parseMode",
      type: "enum",
      default: "none",
      options: [{ value: "none" }, { value: "HTML" }, { value: "Markdown" }, { value: "MarkdownV2" }],
      showWhen: when("sendMessage", "editMessageText", ...WITH_CAPTION),
    },
    // file_id, HTTP-ссылка или file:путь внутри каталога файлов
    { name: "file", type: "string", required: true, showWhen: when(...Object.keys(MEDIA_FIELD)) },
    { name: "fileName", type: "string", default: "", showWhen: when(...Object.keys(MEDIA_FIELD)) },
    { name: "caption", type: "string", multiline: true, showWhen: when(...WITH_CAPTION) },
    // reply_markup как JSON Bot API: { "inline_keyboard": [[{ "text": "Да", "callback_data": "yes" }]] }
    { name: "replyMarkup", type: "json", default: null, showWhen: when("sendMessage", "editMessageText", "sendLocation", ...Object.keys(MEDIA_FIELD)) },
    { name: "latitude", type: "string", required: true, showWhen: when("sendLocation") },
    { name: "longitude", type: "string", required: true, showWhen: when("sendLocation") },
    // [{ "type": "photo", "media": "file_id | URL | file:путь", "caption": "…" }] — 2–10 элементов
    { name: "media", type: "json", default: [], showWhen: when("sendMediaGroup") },
    {
      name: "action",
      type: "enum",
      default: "typing",
      options: CHAT_ACTIONS.map((value) => ({ value })),
      showWhen: when("sendChatAction"),
    },
    { name: "queryId", type: "string", required: true, showWhen: when(...CALLBACK) },
    // answerInlineQuery: массив InlineQueryResult (до 50)
    { name: "results", type: "json", default: [], showWhen: when("answerInlineQuery") },
    { name: "fileId", type: "string", required: true, showWhen: when("getFile") },
    { name: "download", type: "boolean", default: false, showWhen: when("getFile") },
    // сохранить скачанный файл в каталог файлов (относительный путь)
    { name: "saveTo", type: "string", default: "", showWhen: when("getFile") },
    { name: "disableNotification", type: "boolean", default: false, showWhen: when(...SEND, "pinChatMessage") },
    { name: "disableWebPagePreview", type: "boolean", default: false, showWhen: when("sendMessage", "editMessageText") },
    { name: "replyToMessageId", type: "string", default: "", showWhen: when(...SEND) },
    { name: "messageThreadId", type: "string", default: "", showWhen: when(...SEND) },
    // любые другие параметры метода Bot API (snake_case): { "cache_time": 5, "show_alert": true, "protect_content": true }
    { name: "additional", type: "json", default: {} },
    { name: "timeoutMs", type: "number", default: 30_000, min: 1000, max: 300_000 },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    const op = String(params["operation"] ?? "");
    if (!TELEGRAM_OPERATIONS.includes(op)) throw new Error(`Unknown Telegram operation "${op}"`);
    const token = resolveSecret(params["token"], TELEGRAM_TOKEN_ENV);
    try {
      assertToken(token);
      return { out0: await this.execute(op, token, inputs["in0"] ?? null, params, ctx) };
    } catch (e) {
      // токен не должен попасть ни в сообщение, ни в цепочку причин (поэтому исходная ошибка не прикрепляется)
      // eslint-disable-next-line preserve-caught-error -- исходная ошибка не прикрепляется намеренно (токен)
      throw new Error(redact(e instanceof Error ? e.message : String(e), [token]));
    }
  }

  private async execute(op: string, token: string, input: Json, params: Record<string, Json>, ctx: RunContext): Promise<Json> {
    /** Строковый параметр с подстановкой `{{ путь }}`; пустой — "" (или ошибка, если required). */
    const str = (name: string, label: string, required = false): string => {
      const raw = params[name];
      const s = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : String(raw);
      if (s === "") {
        if (required) throw new Error(`Telegram: ${label} is required`);
        return "";
      }
      const v = interpolate(s, input);
      if (v === null || v === "") {
        if (required) throw new Error(`Telegram: ${label} resolved to no value`);
        return "";
      }
      return typeof v === "string" ? v : JSON.stringify(v);
    };
    const json = (name: string): Json => resolveTemplates(params[name] ?? null, input);
    const num = (name: string, label: string): number => {
      const n = Number(str(name, label, true));
      if (!Number.isFinite(n)) throw new Error(`Telegram: ${label} must be a number`);
      return n;
    };
    const idOrName = (v: string): Json => (/^-?\d+$/.test(v) ? Number(v) : v);

    const body: Record<string, Json | undefined> = {};
    const uploads: TelegramUpload[] = [];
    const callOpts = { signal: ctx.signal, timeoutMs: Number(params["timeoutMs"] ?? 30_000) };
    const extra = params["additional"] ?? {};
    if (!isPlainObject(extra)) throw new Error('Telegram: "additional" must be an object');
    for (const k of Object.keys(extra)) if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`Telegram: invalid additional parameter "${k}"`);
    Object.assign(body, resolveTemplates(extra, input) as Record<string, Json>); // дальше заданные поля перекрывают additional

    if (needsChat(op)) body["chat_id"] = idOrName(str("chatId", "chatId", true));

    /** Общие поля отправки: тихо, ответ на сообщение, ветка форума, разметка. */
    const sendExtras = () => {
      if (params["disableNotification"] === true) body["disable_notification"] = true;
      const reply = str("replyToMessageId", "replyToMessageId");
      if (reply) body["reply_parameters"] = { message_id: Number(reply) };
      const thread = str("messageThreadId", "messageThreadId");
      if (thread) body["message_thread_id"] = Number(thread);
    };
    const markup = () => {
      const m = json("replyMarkup");
      if (m !== null && m !== undefined) {
        if (!isPlainObject(m)) throw new Error('Telegram: "replyMarkup" must be an object');
        body["reply_markup"] = m;
      }
    };
    const parseMode = () => {
      const pm = String(params["parseMode"] ?? "none");
      if (pm !== "none") body["parse_mode"] = pm;
    };
    /** `file:путь` читается из каталога файлов; всё остальное (file_id, ссылка) уходит как есть. */
    const fileSource = async (value: string, field: string, name?: string): Promise<string> => {
      if (!value.startsWith(FILE_PREFIX)) return value;
      const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
      const nodePath = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:path");
      const abs = await resolveInside(await filesBaseDir(), value.slice(FILE_PREFIX.length));
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) throw new Error(`Telegram: file "${value.slice(FILE_PREFIX.length)}" does not exist`);
      if (st.size > MAX_UPLOAD_BYTES) throw new Error(`Telegram: file is larger than ${MAX_UPLOAD_BYTES} bytes`);
      uploads.push({ field, fileName: name || nodePath.basename(abs), bytes: await fs.readFile(abs) });
      return `attach://${field}`;
    };

    let method = op;
    switch (op) {
      case "getChat": case "getChatAdministrators": case "leaveChat":
        break;
      case "getChatMember":
        body["user_id"] = idOrName(str("userId", "userId", true));
        break;
      case "setChatTitle":
        body["title"] = str("text", "title (text)", true);
        break;
      case "setChatDescription":
        body["description"] = str("text", "description (text)", true);
        break;
      case "answerCallbackQuery": {
        body["callback_query_id"] = str("queryId", "queryId", true);
        const t = str("text", "text");
        if (t) body["text"] = t;
        break;
      }
      case "answerInlineQuery": {
        body["inline_query_id"] = str("queryId", "queryId", true);
        const results = json("results");
        if (!Array.isArray(results) || results.length === 0) throw new Error('Telegram: "results" must be a non-empty list');
        if (results.length > 50) throw new Error("Telegram: at most 50 inline results");
        body["results"] = results;
        break;
      }
      case "getFile":
        body["file_id"] = str("fileId", "fileId", true);
        break;
      case "deleteMessage":
        body["message_id"] = num("messageId", "messageId");
        break;
      case "pinChatMessage":
        body["message_id"] = num("messageId", "messageId");
        if (params["disableNotification"] === true) body["disable_notification"] = true;
        break;
      case "unpinChatMessage":
        body["message_id"] = num("messageId", "messageId");
        break;
      case "editMessageText":
        body["message_id"] = num("messageId", "messageId");
        body["text"] = str("text", "text", true);
        parseMode();
        markup();
        if (params["disableWebPagePreview"] === true) body["link_preview_options"] = { is_disabled: true };
        break;
      case "sendMessage":
        body["text"] = str("text", "text", true);
        parseMode();
        sendExtras();
        markup();
        if (params["disableWebPagePreview"] === true) body["link_preview_options"] = { is_disabled: true };
        break;
      case "sendChatAction":
        body["action"] = String(params["action"] ?? "typing");
        if (!CHAT_ACTIONS.includes(String(body["action"]))) throw new Error(`Unknown chat action "${String(body["action"])}"`);
        break;
      case "sendLocation":
        body["latitude"] = num("latitude", "latitude");
        body["longitude"] = num("longitude", "longitude");
        sendExtras();
        markup();
        break;
      case "sendMediaGroup": {
        const media = json("media");
        if (!Array.isArray(media) || media.length < 2 || media.length > 10) throw new Error('Telegram: "media" must be a list of 2 to 10 items');
        const items: Json[] = [];
        for (const [i, item] of media.entries()) {
          if (!isPlainObject(item) || typeof item["type"] !== "string" || typeof item["media"] !== "string") {
            throw new Error(`Telegram: media[${i}] must be { type, media }`);
          }
          items.push({ ...item, media: await fileSource(item["media"], `file${i}`) });
        }
        body["media"] = items;
        sendExtras();
        break;
      }
      default: {
        // sendPhoto / sendDocument / sendVideo / sendAudio / sendAnimation / sendSticker
        const field = MEDIA_FIELD[op];
        if (!field) throw new Error(`Unknown Telegram operation "${op}"`);
        body[field] = await fileSource(str("file", "file", true), field, str("fileName", "fileName"));
        if (WITH_CAPTION.includes(op)) {
          const c = str("caption", "caption");
          if (c) {
            body["caption"] = c;
            parseMode();
          }
        }
        sendExtras();
        markup();
        method = op;
      }
    }

    const result = await callTelegram(token, method, body, { ...callOpts, uploads });

    if (op === "getFile" && params["download"] === true && isPlainObject(result)) {
      const filePath = result["file_path"];
      if (typeof filePath !== "string") throw new Error("Telegram: the file has no download path");
      const bytes = await downloadTelegramFile(token, filePath, callOpts);
      const out: { [key: string]: Json } = { ...result, size: bytes.byteLength, content: Buffer.from(bytes).toString("base64") };
      const saveTo = str("saveTo", "saveTo");
      if (saveTo) {
        const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
        const nodePath = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:path");
        const abs = await resolveInside(await filesBaseDir(), saveTo);
        await fs.mkdir(nodePath.dirname(abs), { recursive: true });
        await fs.writeFile(abs, bytes);
        out["savedTo"] = saveTo;
      }
      return out;
    }
    return typeof result === "boolean" ? { ok: result } : result;
  }
}

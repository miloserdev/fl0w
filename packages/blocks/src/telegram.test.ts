import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import type { Block, RunContext } from "./block";
import { isParamVisible, resolveParams, validateParams } from "./params";
import { redact, resolveSecret } from "./secrets";
import { FILES_DIR_ENV } from "./sandbox";
import { Telegram, TELEGRAM_OPERATIONS } from "./telegram";
import { TELEGRAM_API_ENV, assertToken, callTelegram } from "./telegram-api";

const TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

type Call = { method: string; path: string; json?: Record<string, Json>; form?: Record<string, string>; files?: { field: string; name: string; text: string }[] };
type Reply = { status?: number; body: unknown } | "hang";

let server: Server;
let base: string;
let calls: Call[];
let replies: Map<string, Reply | ((c: Call) => Reply)>;
let downloads: Map<string, Buffer>;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const buf = await readBody(req);
    const url = req.url ?? "";
    const dl = /^\/file\/bot([^/]+)\/(.+)$/.exec(url);
    if (dl) {
      const data = downloads.get(dl[2]!);
      if (!data) return void res.writeHead(404).end("nope");
      return void res.writeHead(200, { "content-length": data.length }).end(data);
    }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    if (!m) return void res.writeHead(404).end();
    const call: Call = { method: m[2]!, path: url };
    const ct = req.headers["content-type"] ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await new Response(new Uint8Array(buf), { headers: { "content-type": ct } }).formData();
      call.form = {};
      call.files = [];
      for (const [k, v] of (form as unknown as { entries(): Iterable<[string, FormDataEntryValue]> }).entries()) {
        if (typeof v === "string") call.form[k] = v;
        else call.files.push({ field: k, name: v.name, text: await v.text() });
      }
    } else call.json = buf.length ? (JSON.parse(buf.toString("utf8")) as Record<string, Json>) : {};
    calls.push(call);
    const r = replies.get(call.method);
    const reply = typeof r === "function" ? r(call) : r;
    if (reply === "hang") return;
    if (!reply) return void res.writeHead(200).end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: call.json?.["chat_id"] ?? null } } }));
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" }).end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  calls = [];
  replies = new Map();
  downloads = new Map();
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-tg-"));
  for (const k of [TELEGRAM_API_ENV, FILES_DIR_ENV, "FL0W_SECRET_TELEGRAM_BOT_TOKEN", "FL0W_SECRET_OTHER", "NOT_A_SECRET"]) saved[k] = process.env[k];
  process.env[TELEGRAM_API_ENV] = base;
  process.env[FILES_DIR_ENV] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ctx = (c: Partial<RunContext> = {}): RunContext => ({ log() {}, signal: new AbortController().signal, ...c });
const run = (params: Record<string, Json>, input: Json | undefined = null, c: Partial<RunContext> = {}) =>
  new (Telegram as unknown as new () => Block)().run({ in0: input }, resolveParams(Telegram.params, { token: TOKEN, ...params }), ctx(c));
const out = async (...a: Parameters<typeof run>) => (await run(...a))["out0"];

describe("секреты", () => {
  it("литерал, ссылка env:FL0W_SECRET_*, значение по умолчанию", () => {
    process.env["FL0W_SECRET_OTHER"] = "secret-from-env";
    process.env["FL0W_SECRET_TELEGRAM_BOT_TOKEN"] = "default-token";
    expect(resolveSecret("literal")).toBe("literal");
    expect(resolveSecret("env:FL0W_SECRET_OTHER")).toBe("secret-from-env");
    expect(resolveSecret("", "FL0W_SECRET_TELEGRAM_BOT_TOKEN")).toBe("default-token");
    expect(resolveSecret(undefined, "FL0W_SECRET_TELEGRAM_BOT_TOKEN")).toBe("default-token");
  });
  it("читаются только переменные с префиксом FL0W_SECRET_", () => {
    process.env["NOT_A_SECRET"] = "x";
    for (const bad of ["env:PATH", "env:NOT_A_SECRET", "env:fl0w_secret_lower", "env:FL0W_SECRET_", "env:FL0W_SECRET_A B", "env:FL0W_SECRET_OTHER; echo"]) {
      expect(() => resolveSecret(bad), bad).toThrow(/Only server variables named FL0W_SECRET_/);
    }
  });
  it("не заданная переменная и пустой секрет — понятные ошибки", () => {
    delete process.env["FL0W_SECRET_OTHER"];
    expect(() => resolveSecret("env:FL0W_SECRET_OTHER")).toThrow("Secret FL0W_SECRET_OTHER is not set on the server");
    expect(() => resolveSecret("")).toThrow(/not set/);
  });
  it("redact скрывает секрет везде", () => {
    expect(redact(`fail at /bot${TOKEN}/send and ${TOKEN}`, [TOKEN])).toBe("fail at /bot***/send and ***");
    expect(redact("short", ["abc"])).toBe("short"); // слишком короткий «секрет» не трогаем
  });
  it("токен проверяется по формату BotFather", () => {
    expect(() => assertToken(TOKEN)).not.toThrow();
    for (const bad of ["", "abc", "123:short", `${TOKEN}/../x`, `${TOKEN}?x=1`, `${TOKEN} `, "1234:" + "A".repeat(29), "bot" + TOKEN]) {
      expect(() => assertToken(bad), bad).toThrow(/invalid format/);
    }
  });
});

describe("клиент Bot API", () => {
  it("токен идёт в путь URL, тело — JSON, пустые значения не отправляются", async () => {
    await callTelegram(TOKEN, "sendMessage", { chat_id: 1, text: "hi", skip: undefined, nul: null as unknown as undefined });
    expect(calls[0]).toMatchObject({ method: "sendMessage", path: `/bot${TOKEN}/sendMessage`, json: { chat_id: 1, text: "hi" } });
    expect(calls[0]!.json).not.toHaveProperty("skip");
    expect(calls[0]!.json).not.toHaveProperty("nul");
  });
  it("ошибка API: код и описание; retry_after", async () => {
    replies.set("sendMessage", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } });
    await expect(callTelegram(TOKEN, "sendMessage", {})).rejects.toThrow("Telegram error 400: Bad Request: chat not found");
    replies.set("sendMessage", { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } });
    await expect(callTelegram(TOKEN, "sendMessage", {})).rejects.toThrow("Telegram error 429: Too Many Requests (retry after 7 s)");
  });
  it("не-JSON ответ, недоступный сервер, таймаут, отмена", async () => {
    replies.set("a", { status: 502, body: "<html>bad gateway</html>" });
    await expect(callTelegram(TOKEN, "a", {})).rejects.toThrow("Telegram returned HTTP 502 (not JSON)");
    process.env[TELEGRAM_API_ENV] = "http://127.0.0.1:1";
    await expect(callTelegram(TOKEN, "a", {})).rejects.toThrow(/Telegram request failed/);
    process.env[TELEGRAM_API_ENV] = base;
    replies.set("slow", "hang");
    await expect(callTelegram(TOKEN, "slow", {}, { timeoutMs: 150 })).rejects.toThrow("Telegram request timed out");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(callTelegram(TOKEN, "slow", {}, { signal: ac.signal })).rejects.toThrow("Aborted");
  });
  it("токен не попадает в сообщения об ошибках", async () => {
    process.env[TELEGRAM_API_ENV] = "http://127.0.0.1:1";
    const e1 = await callTelegram(TOKEN, "a", {}).catch((e: Error) => e);
    expect((e1 as Error).message).not.toContain(TOKEN);
    process.env[TELEGRAM_API_ENV] = base;
    replies.set("a", { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` } });
    const e2 = await callTelegram(TOKEN, "a", {}).catch((e: Error) => e);
    expect((e2 as Error).message).not.toContain(TOKEN);
    expect((e2 as Error).message).toContain("***");
  });
  it("кривые адрес API и имя метода", async () => {
    process.env[TELEGRAM_API_ENV] = "ftp://example.com";
    await expect(callTelegram(TOKEN, "a", {})).rejects.toThrow(/http\(s\)/);
    process.env[TELEGRAM_API_ENV] = "not a url";
    await expect(callTelegram(TOKEN, "a", {})).rejects.toThrow(/not a valid URL/);
    process.env[TELEGRAM_API_ENV] = base;
    await expect(callTelegram(TOKEN, "../evil", {})).rejects.toThrow(/Invalid Telegram method/);
    await expect(callTelegram(TOKEN, "send Message", {})).rejects.toThrow(/Invalid Telegram method/);
  });
});

describe("Telegram: сообщения", () => {
  it("sendMessage: поля тела, результат — объект сообщения", async () => {
    replies.set("sendMessage", { body: { ok: true, result: { message_id: 42, text: "hello" } } });
    const r = await out({ operation: "sendMessage", chatId: "-100123", text: "hello" });
    expect(r).toEqual({ message_id: 42, text: "hello" });
    expect(calls[0]!.json).toEqual({ chat_id: -100123, text: "hello" });
  });
  it("chat_id: число — числом, @канал — строкой", async () => {
    await run({ operation: "sendMessage", chatId: "@mychannel", text: "x" });
    await run({ operation: "sendMessage", chatId: "42", text: "x" });
    expect(calls.map((c) => c.json!["chat_id"])).toEqual(["@mychannel", 42]);
  });
  it("parse_mode, тихая отправка, превью, ответ на сообщение, ветка форума, reply_markup", async () => {
    const markup = { inline_keyboard: [[{ text: "Да", callback_data: "yes" }]] };
    await run({
      operation: "sendMessage", chatId: "1", text: "*b*", parseMode: "MarkdownV2", disableNotification: true,
      disableWebPagePreview: true, replyToMessageId: "77", messageThreadId: "5", replyMarkup: markup,
    });
    expect(calls[0]!.json).toEqual({
      chat_id: 1, text: "*b*", parse_mode: "MarkdownV2", disable_notification: true,
      link_preview_options: { is_disabled: true }, reply_parameters: { message_id: 77 }, message_thread_id: 5, reply_markup: markup,
    });
  });
  it("по умолчанию parse_mode не отправляется (обычный текст)", async () => {
    await run({ operation: "sendMessage", chatId: "1", text: "a <b> c" });
    expect(calls[0]!.json).not.toHaveProperty("parse_mode");
  });
  it("шаблоны берут данные из входа — например, из Telegram Trigger", async () => {
    const update = { update_id: 1, message: { message_id: 9, chat: { id: 555 }, from: { first_name: "Ann" }, text: "ping" } };
    await run({ operation: "sendMessage", chatId: "{{ message.chat.id }}", text: "Hi {{ message.from.first_name }}: {{ message.text }}", replyToMessageId: "{{ message.message_id }}" }, update);
    expect(calls[0]!.json).toMatchObject({ chat_id: 555, text: "Hi Ann: ping", reply_parameters: { message_id: 9 } });
  });
  it("шаблон без значения — ошибка, а не отправка «null»", async () => {
    await expect(run({ operation: "sendMessage", chatId: "{{ nope }}", text: "x" }, {})).rejects.toThrow(/chatId resolved to no value/);
    expect(calls).toEqual([]);
  });
  it("additional: произвольные параметры; они не перекрывают заданные поля", async () => {
    await run({ operation: "sendMessage", chatId: "1", text: "real", additional: { protect_content: true, chat_id: 999, text: "evil" } });
    expect(calls[0]!.json).toEqual({ chat_id: 1, text: "real", protect_content: true });
    await expect(run({ operation: "sendMessage", chatId: "1", text: "x", additional: { "Bad-Key": 1 } })).rejects.toThrow(/invalid additional parameter/);
    await expect(run({ operation: "sendMessage", chatId: "1", text: "x", additional: [1] })).rejects.toThrow(/must be an object/);
  });
  it("обязательные поля: понятные ошибки до запроса", async () => {
    await expect(run({ operation: "sendMessage", chatId: "1" })).rejects.toThrow("text is required");
    await expect(run({ operation: "sendMessage", text: "x" })).rejects.toThrow("chatId is required");
    await expect(run({ operation: "nope", chatId: "1" })).rejects.toThrow(/Unknown Telegram operation/);
    expect(calls).toEqual([]);
  });
});

describe("Telegram: остальные операции", () => {
  it.each([
    ["getChat", { chatId: "5" }, "getChat", { chat_id: 5 }],
    ["getChatAdministrators", { chatId: "@c" }, "getChatAdministrators", { chat_id: "@c" }],
    ["getChatMember", { chatId: "5", userId: "9" }, "getChatMember", { chat_id: 5, user_id: 9 }],
    ["leaveChat", { chatId: "5" }, "leaveChat", { chat_id: 5 }],
    ["setChatTitle", { chatId: "5", text: "Новое имя" }, "setChatTitle", { chat_id: 5, title: "Новое имя" }],
    ["setChatDescription", { chatId: "5", text: "О чате" }, "setChatDescription", { chat_id: 5, description: "О чате" }],
    ["deleteMessage", { chatId: "5", messageId: "11" }, "deleteMessage", { chat_id: 5, message_id: 11 }],
    ["pinChatMessage", { chatId: "5", messageId: "11", disableNotification: true }, "pinChatMessage", { chat_id: 5, message_id: 11, disable_notification: true }],
    ["unpinChatMessage", { chatId: "5", messageId: "11" }, "unpinChatMessage", { chat_id: 5, message_id: 11 }],
    ["editMessageText", { chatId: "5", messageId: "11", text: "правка", parseMode: "HTML" }, "editMessageText", { chat_id: 5, message_id: 11, text: "правка", parse_mode: "HTML" }],
    ["sendChatAction", { chatId: "5", action: "upload_photo" }, "sendChatAction", { chat_id: 5, action: "upload_photo" }],
    ["sendLocation", { chatId: "5", latitude: "55.75", longitude: "37.61" }, "sendLocation", { chat_id: 5, latitude: 55.75, longitude: 37.61 }],
    ["answerCallbackQuery", { queryId: "q1", text: "Готово", additional: { show_alert: true, cache_time: 3 } }, "answerCallbackQuery", { callback_query_id: "q1", text: "Готово", show_alert: true, cache_time: 3 }],
    ["answerInlineQuery", { queryId: "q2", results: [{ type: "article", id: "1", title: "t", input_message_content: { message_text: "m" } }] }, "answerInlineQuery", { inline_query_id: "q2", results: [{ type: "article", id: "1", title: "t", input_message_content: { message_text: "m" } }] }],
    ["getFile", { fileId: "AgAD" }, "getFile", { file_id: "AgAD" }],
  ] as [string, Record<string, Json>, string, Record<string, Json>][])("%s → %s", async (operation, params, method, body) => {
    await run({ operation, ...params });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method, json: body });
  });

  it("операции с ответом true дают { ok: true }", async () => {
    replies.set("deleteMessage", { body: { ok: true, result: true } });
    expect(await out({ operation: "deleteMessage", chatId: "1", messageId: "2" })).toEqual({ ok: true });
    replies.set("getChatAdministrators", { body: { ok: true, result: [{ user: { id: 1 } }] } });
    expect(await out({ operation: "getChatAdministrators", chatId: "1" })).toEqual([{ user: { id: 1 } }]);
  });

  it("проверки: сообщение 1, число, действие, результаты inline", async () => {
    await expect(run({ operation: "deleteMessage", chatId: "1", messageId: "abc" })).rejects.toThrow("messageId must be a number");
    await expect(run({ operation: "sendLocation", chatId: "1", latitude: "x", longitude: "1" })).rejects.toThrow("latitude must be a number");
    await expect(run({ operation: "sendChatAction", chatId: "1", action: "dancing" })).rejects.toThrow(/Unknown chat action/);
    await expect(run({ operation: "answerInlineQuery", queryId: "q", results: [] })).rejects.toThrow(/non-empty list/);
    await expect(run({ operation: "answerInlineQuery", queryId: "q", results: Array.from({ length: 51 }, (_, i) => ({ id: String(i) })) })).rejects.toThrow(/at most 50/);
    expect(calls).toEqual([]);
  });

  it("покрыты все операции из списка", () => {
    // как в n8n: Chat 6 + Callback 2 + File 1 + Message 14
    expect(TELEGRAM_OPERATIONS).toHaveLength(23);
    expect(new Set(TELEGRAM_OPERATIONS).size).toBe(23);
  });
});

describe("Telegram: файлы", () => {
  it("file_id и ссылка отправляются как есть (JSON), подпись и разметка — тоже", async () => {
    await run({ operation: "sendPhoto", chatId: "1", file: "AgACAgIAAxkBAAI", caption: "Фото", parseMode: "HTML" });
    await run({ operation: "sendDocument", chatId: "1", file: "https://example.com/a.pdf" });
    expect(calls[0]!.json).toEqual({ chat_id: 1, photo: "AgACAgIAAxkBAAI", caption: "Фото", parse_mode: "HTML" });
    expect(calls[1]!.json).toEqual({ chat_id: 1, document: "https://example.com/a.pdf" });
  });

  it("file:путь загружает файл из каталога файлов multipart-запросом", async () => {
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs/report.txt"), "содержимое отчёта");
    await run({ operation: "sendDocument", chatId: "7", file: "file:docs/report.txt", caption: "Отчёт", replyMarkup: { inline_keyboard: [] } });
    expect(calls[0]!.json).toBeUndefined();
    expect(calls[0]!.form).toEqual({ chat_id: "7", document: "attach://document", caption: "Отчёт", reply_markup: '{"inline_keyboard":[]}' });
    expect(calls[0]!.files).toEqual([{ field: "document", name: "report.txt", text: "содержимое отчёта" }]);
  });

  it("fileName переопределяет имя; путь поддерживает шаблоны", async () => {
    writeFileSync(path.join(dir, "a.bin"), "x");
    await run({ operation: "sendPhoto", chatId: "1", file: "file:{{ name }}", fileName: "cat.jpg" }, { name: "a.bin" });
    expect(calls[0]!.files![0]).toMatchObject({ field: "photo", name: "cat.jpg" });
  });

  it("файл вне каталога, симлинк наружу и несуществующий файл отвергаются без запроса", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "fl0w-tg-out-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "s");
      symlinkSync(outside, path.join(dir, "ln"));
      await expect(run({ operation: "sendDocument", chatId: "1", file: "file:../secret.txt" })).rejects.toThrow(/\.\./);
      await expect(run({ operation: "sendDocument", chatId: "1", file: `file:${path.join(outside, "secret.txt")}` })).rejects.toThrow(/relative/);
      await expect(run({ operation: "sendDocument", chatId: "1", file: "file:ln/secret.txt" })).rejects.toThrow(/outside/);
      await expect(run({ operation: "sendDocument", chatId: "1", file: "file:nope.txt" })).rejects.toThrow(/does not exist/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("sendMediaGroup: смесь file_id, ссылок и загружаемых файлов через attach://", async () => {
    writeFileSync(path.join(dir, "one.jpg"), "JPEG1");
    await run({
      operation: "sendMediaGroup", chatId: "1",
      media: [{ type: "photo", media: "file:one.jpg", caption: "первая" }, { type: "photo", media: "https://example.com/two.jpg" }, { type: "video", media: "AgAD_id" }],
    });
    expect(calls[0]!.form!["chat_id"]).toBe("1");
    expect(JSON.parse(calls[0]!.form!["media"]!)).toEqual([
      { type: "photo", media: "attach://file0", caption: "первая" },
      { type: "photo", media: "https://example.com/two.jpg" },
      { type: "video", media: "AgAD_id" },
    ]);
    expect(calls[0]!.files).toEqual([{ field: "file0", name: "one.jpg", text: "JPEG1" }]);
    // без файлов — обычный JSON
    await run({ operation: "sendMediaGroup", chatId: "1", media: [{ type: "photo", media: "a" }, { type: "photo", media: "b" }] });
    expect(calls[1]!.json).toMatchObject({ media: [{ type: "photo", media: "a" }, { type: "photo", media: "b" }] });
  });

  it("sendMediaGroup: 2–10 элементов и корректная форма", async () => {
    await expect(run({ operation: "sendMediaGroup", chatId: "1", media: [{ type: "photo", media: "a" }] })).rejects.toThrow(/2 to 10/);
    await expect(run({ operation: "sendMediaGroup", chatId: "1", media: Array.from({ length: 11 }, () => ({ type: "photo", media: "a" })) })).rejects.toThrow(/2 to 10/);
    await expect(run({ operation: "sendMediaGroup", chatId: "1", media: [{ type: "photo", media: "a" }, { type: "photo" }] })).rejects.toThrow(/media\[1\]/);
  });

  it("getFile + download: содержимое в base64, сохранение в каталог файлов", async () => {
    replies.set("getFile", { body: { ok: true, result: { file_id: "F", file_size: 5, file_path: "photos/file_1.jpg" } } });
    downloads.set("photos/file_1.jpg", Buffer.from([0, 1, 2, 250, 255]));
    const r = (await out({ operation: "getFile", fileId: "F", download: true, saveTo: "in/photo.jpg" })) as Record<string, Json>;
    expect(r).toMatchObject({ file_id: "F", size: 5, content: Buffer.from([0, 1, 2, 250, 255]).toString("base64"), savedTo: "in/photo.jpg" });
    expect(readFileSync(path.join(dir, "in/photo.jpg"))).toEqual(Buffer.from([0, 1, 2, 250, 255]));
    // без download — только описание файла
    const meta = (await out({ operation: "getFile", fileId: "F" })) as Record<string, Json>;
    expect(meta).not.toHaveProperty("content");
  });

  it("скачивание: небезопасный путь от сервера, 404, saveTo вне каталога", async () => {
    replies.set("getFile", { body: { ok: true, result: { file_path: "../../etc/passwd" } } });
    await expect(run({ operation: "getFile", fileId: "F", download: true })).rejects.toThrow(/unsafe file path/);
    replies.set("getFile", { body: { ok: true, result: { file_path: "missing/x.jpg" } } });
    await expect(run({ operation: "getFile", fileId: "F", download: true })).rejects.toThrow(/HTTP 404/);
    replies.set("getFile", { body: { ok: true, result: { file_path: "a/b.jpg" } } });
    downloads.set("a/b.jpg", Buffer.from("x"));
    await expect(run({ operation: "getFile", fileId: "F", download: true, saveTo: "../escape.jpg" })).rejects.toThrow(/\.\./);
    expect(existsSync(path.join(dir, "..", "escape.jpg"))).toBe(false);
  });
});

describe("Telegram: токен и безопасность", () => {
  it("пустой токен берётся из FL0W_SECRET_TELEGRAM_BOT_TOKEN, ссылка env: — из указанной переменной", async () => {
    process.env["FL0W_SECRET_TELEGRAM_BOT_TOKEN"] = TOKEN;
    process.env["FL0W_SECRET_OTHER"] = "999999:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11";
    await run({ token: "", operation: "getChat", chatId: "1" });
    await run({ token: "env:FL0W_SECRET_OTHER", operation: "getChat", chatId: "1" });
    expect(calls.map((c) => c.path.split("/")[1])).toEqual([`bot${TOKEN}`, "bot999999:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11"]);
  });

  it("в ошибке блока токена нет — ни литерального, ни из env", async () => {
    process.env[TELEGRAM_API_ENV] = "http://127.0.0.1:1";
    const e = (await run({ operation: "getChat", chatId: "1" }).catch((x: Error) => x)) as Error;
    expect(e.message).toMatch(/Telegram request failed/);
    expect(e.message).not.toContain(TOKEN);
    expect(e.cause).toBeUndefined();
    const bad = (await run({ token: "garbage ✂ token", operation: "getChat", chatId: "1" }).catch((x: Error) => x)) as Error;
    expect(bad.message).toMatch(/invalid format/);
    expect(bad.message).not.toContain("garbage");
  });

  it("отмена запуска прерывает запрос", async () => {
    replies.set("getChat", "hang");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await expect(run({ operation: "getChat", chatId: "1" }, null, { signal: ac.signal })).rejects.toThrow("Aborted");
  });
});

describe("Telegram: параметры и видимость", () => {
  const visible = (op: string, name: string, extra: Record<string, Json> = {}) =>
    isParamVisible(Telegram.params.find((p) => p.name === name)!, resolveParams(Telegram.params, { operation: op, ...extra }));

  it("поля показываются только там, где применимы", () => {
    expect(visible("sendMessage", "text")).toBe(true);
    expect(visible("sendMessage", "file")).toBe(false);
    expect(visible("sendPhoto", "file")).toBe(true);
    expect(visible("sendPhoto", "text")).toBe(false);
    expect(visible("sendPhoto", "caption")).toBe(true);
    expect(visible("sendSticker", "caption")).toBe(false);
    expect(visible("getFile", "chatId")).toBe(false);
    expect(visible("getFile", "fileId")).toBe(true);
    expect(visible("answerCallbackQuery", "queryId")).toBe(true);
    expect(visible("answerCallbackQuery", "chatId")).toBe(false);
    expect(visible("sendLocation", "latitude")).toBe(true);
    expect(visible("sendMediaGroup", "media")).toBe(true);
    expect(visible("getChatMember", "userId")).toBe(true);
    expect(visible("deleteMessage", "messageId")).toBe(true);
    expect(visible("sendMessage", "messageId")).toBe(false);
  });

  it("обязательные поля проверяются только у видимых (публикация ловит пропуски)", () => {
    const issues = (p: Record<string, Json>) => validateParams(Telegram.params, p).map((i) => i.param).sort();
    expect(issues({ operation: "sendMessage" })).toEqual(["chatId"]);
    expect(issues({ operation: "sendMessage", chatId: "1" })).toEqual([]);
    expect(issues({ operation: "sendPhoto", chatId: "1" })).toEqual(["file"]);
    expect(issues({ operation: "getFile" })).toEqual(["fileId"]);
    expect(issues({ operation: "answerInlineQuery" })).toEqual(["queryId"]);
    expect(issues({ operation: "sendLocation", chatId: "1" })).toEqual(["latitude", "longitude"]);
  });

  it("мета: приложение, порты, токен не обязателен в схеме (есть значение по умолчанию из окружения)", () => {
    expect(Telegram.category).toBe("app");
    expect(Telegram.ports.inputs).toHaveLength(1);
    expect(Telegram.params.find((p) => p.name === "token")?.required).toBeUndefined();
  });
});

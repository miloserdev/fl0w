import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { interpolate } from "./json-path";
import { graphDriver } from "./mail-graph";
import { imapSmtpDriver } from "./mail-imap";
import { MAX_LIST, type MailDriver } from "./mail-types";
import { resolveSecret } from "./secrets";
import { textOf } from "./value-io";

export const MAIL_PROVIDERS = ["imap", "graph"] as const;
export const MAIL_OPERATIONS = ["sendMail", "listMail", "getMail", "markMailRead"] as const;
const ADDRESS = /^[^\s<>@,;"']+@[^\s<>@,;"']+\.[^\s<>@,;"']+$/;
const MAX_RECIPIENTS = 100;

const on = (param: string, ...values: string[]) => ({ param, in: values });
const op = (...ops: string[]) => on("operation", ...ops);

/** Адреса из строки «a@x, b@y; c@z» (запятая, точка с запятой, перенос строки). Любой мусор — ошибка: письмо не уйдёт «куда-нибудь». */
function addresses(raw: string, field: string): string[] {
  const list = raw.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean);
  if (list.length > MAX_RECIPIENTS) throw new Error(`Mail: too many recipients in "${field}" (max ${MAX_RECIPIENTS})`);
  for (const a of list) if (!ADDRESS.test(a)) throw new Error(`Mail: "${a.slice(0, 80)}" in "${field}" is not an email address`);
  return list;
}

/** Строка без переводов строк: тема и адрес — заголовки письма, перевод строки в них — подмена заголовков. */
function oneLine(s: string, field: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error(`Mail: "${field}" must be a single line`);
  return s;
}

/**
 * Mail: почта без привязки к конкретному сервису. Операции — отправить, список писем (фильтры), прочитать письмо, пометить
 * прочитанным; их выполняет драйвер провайдера:
 *  • `imap` — любой почтовый сервер по IMAP (чтение) и SMTP (отправка): Exchange/Outlook, Gmail, Yandex, свой сервер;
 *  • `graph` — Microsoft Graph (Outlook / Microsoft 365) через приложение Azure AD, без дополнительных библиотек.
 * Новый провайдер добавляется драйвером (`MailDriver`) без изменения блока и флоу.
 *
 * Пароль — текстом в параметре либо ссылкой `env:FL0W_SECRET_…`; в логи, события и ошибки он не попадает. Поля `to`, `subject`,
 * `body` и т.п. поддерживают `{{ путь }}` из входа. Получатели проверяются; тема и адреса — одна строка (защита от подмены заголовков).
 */
export class Mail extends Block {
  static type = "mail";
  static label = "Mail";
  static icon = "mail";
  static category = "app";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "provider", type: "enum", default: "imap", options: MAIL_PROVIDERS.map((value) => ({ value })) },
    { name: "operation", type: "enum", default: "sendMail", options: MAIL_OPERATIONS.map((value) => ({ value })) },
    // --- IMAP / SMTP ---
    { name: "host", type: "string", expressions: false, showWhen: on("provider", "imap") },
    { name: "port", type: "number", default: 993, min: 1, max: 65535, showWhen: on("provider", "imap") },
    { name: "secure", type: "boolean", default: true, showWhen: on("provider", "imap") },
    // пусто — тот же сервер, что и для IMAP
    { name: "smtpHost", type: "string", default: "", expressions: false, showWhen: on("provider", "imap") },
    { name: "smtpPort", type: "number", default: 465, min: 1, max: 65535, showWhen: on("provider", "imap") },
    // true — TLS сразу (порт 465), false — STARTTLS (порт 587)
    { name: "smtpSecure", type: "boolean", default: true, showWhen: on("provider", "imap") },
    // не проверять сертификат сервера (внутренние серверы с самоподписанным сертификатом)
    { name: "tlsInsecure", type: "boolean", default: false, showWhen: on("provider", "imap") },
    // --- Microsoft Graph ---
    { name: "tenantId", type: "string", expressions: false, showWhen: on("provider", "graph") },
    { name: "clientId", type: "string", expressions: false, showWhen: on("provider", "graph") },
    // --- общее: логин (адрес ящика) и пароль / client secret ---
    { name: "username", type: "string", required: true, expressions: false },
    { name: "password", type: "string", required: true, expressions: false },
    // --- операции ---
    { name: "folder", type: "string", default: "INBOX", showWhen: op("listMail", "getMail", "markMailRead") },
    { name: "unreadOnly", type: "boolean", default: false, showWhen: op("listMail") },
    { name: "fromFilter", type: "string", default: "", showWhen: op("listMail") },
    { name: "subjectFilter", type: "string", default: "", showWhen: op("listMail") },
    // с какой даты (ISO, например 2026-01-31); пусто — без ограничения
    { name: "since", type: "string", default: "", showWhen: op("listMail") },
    { name: "limit", type: "number", default: 20, min: 1, max: MAX_LIST, showWhen: op("listMail") },
    { name: "messageId", type: "string", default: "", showWhen: op("getMail", "markMailRead") },
    { name: "read", type: "boolean", default: true, showWhen: op("markMailRead") },
    { name: "to", type: "string", default: "", showWhen: op("sendMail") },
    { name: "cc", type: "string", default: "", showWhen: op("sendMail") },
    { name: "bcc", type: "string", default: "", showWhen: op("sendMail") },
    { name: "from", type: "string", default: "", showWhen: op("sendMail") },
    { name: "subject", type: "string", default: "", showWhen: op("sendMail") },
    { name: "body", type: "string", multiline: true, default: "", showWhen: op("sendMail") },
    { name: "html", type: "boolean", default: false, showWhen: op("sendMail") },
    { name: "timeoutMs", type: "number", default: 30_000, min: 1000, max: 300_000 },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    const data = inputs["in0"] ?? null;
    const text = (name: string) => textOf(interpolate(typeof params[name] === "string" ? (params[name] as string) : "", data)).trim();
    const operation = String(params["operation"] ?? "sendMail");
    if (!(MAIL_OPERATIONS as readonly string[]).includes(operation)) throw new Error(`Unknown operation "${operation}"`);
    const provider = String(params["provider"] ?? "imap");
    if (!(MAIL_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown provider "${provider}"`);
    const timeoutMs = Math.min(Math.max(Math.trunc(Number(params["timeoutMs"] ?? 30_000)) || 30_000, 1000), 300_000);

    // входные данные проверяем до подключения: ошибка в параметрах не должна открывать соединение с сервером
    const folder = text("folder") || "INBOX";
    const messageId = text("messageId");
    if ((operation === "getMail" || operation === "markMailRead") && messageId === "") throw new Error('Mail: "messageId" is empty');
    let out: { to: string[]; cc: string[]; bcc: string[]; from: string; subject: string; body: string } | null = null;
    if (operation === "sendMail") {
      const to = addresses(text("to"), "to");
      if (to.length === 0) throw new Error('Mail: "to" is empty');
      const subject = oneLine(text("subject"), "subject");
      const body = textOf(interpolate(typeof params["body"] === "string" ? params["body"] : "", data));
      if (subject === "" && body.trim() === "") throw new Error("Mail: the subject and the body are both empty");
      const from = oneLine(text("from"), "from");
      if (from !== "" && !ADDRESS.test(from)) throw new Error(`Mail: "from" is not an email address`);
      out = { to, cc: addresses(text("cc"), "cc"), bcc: addresses(text("bcc"), "bcc"), from, subject, body };
    }
    let since: Date | null = null;
    if (operation === "listMail" && text("since") !== "") {
      since = new Date(text("since"));
      if (Number.isNaN(since.getTime())) throw new Error('Mail: "since" is not a date (use e.g. 2026-01-31)');
    }

    const username = typeof params["username"] === "string" ? params["username"].trim() : "";
    if (username === "") throw new Error('Mail: "username" is required');
    const password = resolveSecret(typeof params["password"] === "string" ? params["password"].trim() : "", undefined);

    const driver = this.driver(provider, params, { username, password, timeoutMs, signal: ctx.signal });
    try {
      switch (operation) {
        case "sendMail":
          return { out0: await driver.send({ ...out!, html: params["html"] === true }) };
        case "listMail": {
          const limit = Math.min(Math.max(Math.trunc(Number(params["limit"] ?? 20)) || 20, 1), MAX_LIST);
          return { out0: (await driver.list({ folder, unreadOnly: params["unreadOnly"] === true, from: text("fromFilter"), subject: text("subjectFilter"), since, limit })) as unknown as Json };
        }
        case "getMail":
          return { out0: await driver.get(folder, messageId) };
        default:
          return { out0: await driver.markRead(folder, messageId, params["read"] !== false) };
      }
    } finally {
      await driver.close().catch(() => undefined);
    }
  }

  private driver(provider: string, params: Record<string, Json>, c: { username: string; password: string; timeoutMs: number; signal: AbortSignal }): MailDriver {
    const str = (name: string) => (typeof params[name] === "string" ? (params[name] as string).trim() : "");
    const num = (name: string, fallback: number) => {
      const n = Math.trunc(Number(params[name] ?? fallback));
      return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : fallback;
    };
    if (provider === "graph") {
      const tenantId = str("tenantId");
      const clientId = str("clientId");
      if (tenantId === "" || clientId === "") throw new Error('Mail: "tenantId" and "clientId" are required for Microsoft Graph');
      return graphDriver({ tenantId, clientId, clientSecret: c.password, mailbox: c.username, timeoutMs: c.timeoutMs, signal: c.signal });
    }
    const host = str("host");
    if (host === "") throw new Error('Mail: "host" (IMAP server) is required');
    return imapSmtpDriver({
      host,
      port: num("port", 993),
      secure: params["secure"] !== false,
      smtpHost: str("smtpHost") || host,
      smtpPort: num("smtpPort", 465),
      smtpSecure: params["smtpSecure"] !== false,
      username: c.username,
      password: c.password,
      tlsInsecure: params["tlsInsecure"] === true,
      timeoutMs: c.timeoutMs,
      signal: c.signal,
    });
  }
}

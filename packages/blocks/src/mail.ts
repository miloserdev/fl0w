import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { interpolate } from "./json-path";
import { graphDriver } from "./mail-graph";
import { imapSmtpDriver } from "./mail-imap";
import { saveAttachments, withAttachmentPaths } from "./mail-attachments";
import { MAX_LIST, type MailDriver } from "./mail-types";
import { resolveSecret } from "./secrets";
import { textOf } from "./value-io";

export const MAIL_PROVIDERS = ["imap", "graph"] as const;
export const MAIL_OPERATIONS = ["sendMail", "listMail", "getMail", "markMailRead", "replyMail", "moveMail"] as const;
const ADDRESS = /^[^\s<>@,;"']+@[^\s<>@,;"']+\.[^\s<>@,;"']+$/;
const MAX_RECIPIENTS = 100;

const on = (param: string, ...values: string[]) => ({ param, in: values });
const op = (...ops: string[]) => on("operation", ...ops);

/** Addresses from the string "a@x, b@y; c@z" (comma, semicolon, newline). Any garbage is an error: a message must not go "somewhere". */
function addresses(raw: string, field: string): string[] {
  const list = raw.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean);
  if (list.length > MAX_RECIPIENTS) throw new Error(`Mail: too many recipients in "${field}" (max ${MAX_RECIPIENTS})`);
  for (const a of list) if (!ADDRESS.test(a)) throw new Error(`Mail: "${a.slice(0, 80)}" in "${field}" is not an email address`);
  return list;
}

/** A string without line breaks: the subject and address are message headers, and a line break in them is header spoofing. */
function oneLine(s: string, field: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error(`Mail: "${field}" must be a single line`);
  return s;
}

/**
 * Mail: mail not tied to a specific service. Operations: send, list messages (filters), read a message (saving
 * attachments), mark read, reply, move; the provider driver performs them:
 *  * `imap`: any mail server over IMAP (reading) and SMTP (sending): Exchange/Outlook, Gmail, Yandex, your own server;
 *  * `graph`: Microsoft Graph (Outlook / Microsoft 365) through an Azure AD application, with no extra libraries.
 * A new provider is added as a driver (`MailDriver`) without changing the block and flows.
 *
 * The password is plain text in the parameter or a reference `env:FL0W_SECRET_...`; it never reaches logs, events or errors. The fields `to`, `subject`,
 * `body` and the like support `{{ path }}` from the input. Recipients are validated; the subject and addresses are a single line (protection against header spoofing).
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
    // empty means the same server as for IMAP
    { name: "smtpHost", type: "string", default: "", expressions: false, showWhen: on("provider", "imap") },
    { name: "smtpPort", type: "number", default: 465, min: 1, max: 65535, showWhen: on("provider", "imap") },
    // true: TLS right away (port 465), false: STARTTLS (port 587)
    { name: "smtpSecure", type: "boolean", default: true, showWhen: on("provider", "imap") },
    // do not verify the server certificate (internal servers with a self-signed certificate)
    { name: "tlsInsecure", type: "boolean", default: false, showWhen: on("provider", "imap") },
    // --- Microsoft Graph ---
    { name: "tenantId", type: "string", expressions: false, showWhen: on("provider", "graph") },
    { name: "clientId", type: "string", expressions: false, showWhen: on("provider", "graph") },
    // --- common: login (mailbox address) and password / client secret ---
    { name: "username", type: "string", required: true, expressions: false },
    { name: "password", type: "string", required: true, expressions: false },
    // --- operations ---
    { name: "folder", type: "string", default: "INBOX", showWhen: op("listMail", "getMail", "markMailRead", "replyMail", "moveMail") },
    { name: "unreadOnly", type: "boolean", default: false, showWhen: op("listMail") },
    { name: "fromFilter", type: "string", default: "", showWhen: op("listMail") },
    { name: "subjectFilter", type: "string", default: "", showWhen: op("listMail") },
    // from which date (ISO, for example 2026-01-31); empty means no limit
    { name: "since", type: "string", default: "", showWhen: op("listMail") },
    { name: "limit", type: "number", default: 20, min: 1, max: MAX_LIST, showWhen: op("listMail") },
    { name: "messageId", type: "string", default: "", showWhen: op("getMail", "markMailRead", "replyMail", "moveMail") },
    { name: "read", type: "boolean", default: true, showWhen: op("markMailRead") },
    // save attachments into the files directory: <attachmentsDir>/<message id>/<name>; the attachments will get a path in the result
    { name: "saveAttachments", type: "boolean", default: false, showWhen: op("getMail") },
    { name: "attachmentsDir", type: "string", default: "mail", expressions: false, showWhen: op("getMail") },
    { name: "replyAll", type: "boolean", default: false, showWhen: op("replyMail") },
    // where to move: an IMAP folder (for example Archive) or, for Graph, archive, trash, junk, drafts, sent or a folder id
    { name: "destination", type: "string", default: "", showWhen: op("moveMail") },
    { name: "to", type: "string", default: "", showWhen: op("sendMail") },
    { name: "cc", type: "string", default: "", showWhen: op("sendMail") },
    { name: "bcc", type: "string", default: "", showWhen: op("sendMail") },
    { name: "from", type: "string", default: "", showWhen: op("sendMail") },
    { name: "subject", type: "string", default: "", showWhen: op("sendMail") },
    { name: "body", type: "string", multiline: true, default: "", showWhen: op("sendMail", "replyMail") },
    { name: "html", type: "boolean", default: false, showWhen: op("sendMail", "replyMail") },
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

    // we validate input data before connecting: an error in the parameters must not open a connection to the server
    const folder = text("folder") || "INBOX";
    const messageId = text("messageId");
    if (["getMail", "markMailRead", "replyMail", "moveMail"].includes(operation) && messageId === "") throw new Error('Mail: "messageId" is empty');
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
    let replyBody = "";
    if (operation === "replyMail") {
      replyBody = textOf(interpolate(typeof params["body"] === "string" ? params["body"] : "", data));
      if (replyBody.trim() === "") throw new Error('Mail: the reply "body" is empty');
    }
    const destination = text("destination");
    if (operation === "moveMail" && destination === "") throw new Error('Mail: "destination" is empty');
    let since: Date | null = null;
    if (operation === "listMail" && text("since") !== "") {
      since = new Date(text("since"));
      if (Number.isNaN(since.getTime())) throw new Error('Mail: "since" is not a date (use e.g. 2026-01-31)');
    }

    const username = typeof params["username"] === "string" ? params["username"].trim() : "";
    if (username === "") throw new Error('Mail: "username" is required');
    const password = resolveSecret(typeof params["password"] === "string" ? params["password"].trim() : "", undefined);

    const driver = buildMailDriver(provider, params, { username, password, timeoutMs, signal: ctx.signal });
    try {
      switch (operation) {
        case "sendMail":
          return { out0: await driver.send({ ...out!, html: params["html"] === true }) };
        case "listMail": {
          const limit = Math.min(Math.max(Math.trunc(Number(params["limit"] ?? 20)) || 20, 1), MAX_LIST);
          return { out0: (await driver.list({ folder, unreadOnly: params["unreadOnly"] === true, from: text("fromFilter"), subject: text("subjectFilter"), since, limit })) as unknown as Json };
        }
        case "getMail": {
          const msg = await driver.get(folder, messageId);
          if (params["saveAttachments"] === true && msg !== null && typeof msg === "object" && !Array.isArray(msg) && Array.isArray(msg["attachments"]) && msg["attachments"].length > 0) {
            const saved = await saveAttachments(typeof params["attachmentsDir"] === "string" ? params["attachmentsDir"] : "mail", messageId, await driver.attachments(folder, messageId));
            msg["attachments"] = withAttachmentPaths(msg["attachments"], saved);
          }
          return { out0: msg };
        }
        case "replyMail":
          return { out0: await driver.reply(folder, messageId, replyBody, params["html"] === true, params["replyAll"] === true) };
        case "moveMail":
          return { out0: await driver.move(folder, messageId, destination) };
        default:
          return { out0: await driver.markRead(folder, messageId, params["read"] !== false) };
      }
    } finally {
      await driver.close().catch(() => undefined);
    }
  }
}

export function buildMailDriver(provider: string, params: Record<string, Json>, c: { username: string; password: string; timeoutMs: number; signal: AbortSignal }): MailDriver {
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

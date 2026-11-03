import type { Json } from "@fl0w/schema";
import { redact } from "./secrets";
import { MAX_BODY_CHARS, type ListQuery, type MailDriver, type MailItem, type OutMail } from "./mail-types";

export type ImapSmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
  /** Не проверять сертификат сервера (самоподписанные у внутренних серверов). */
  tlsInsecure: boolean;
  timeoutMs: number;
  signal: AbortSignal;
};

const addr = (a: { name?: string; address?: string } | undefined) => (a?.address ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");

/**
 * IMAP (чтение) + SMTP (отправка): работает с любым почтовым сервером — Exchange/Outlook, Gmail, Yandex, собственным.
 * Библиотеки (imapflow, nodemailer, mailparser) загружаются только при вызове и скрыты от сборщика (turbopackIgnore): они нужны
 * лишь в Node (сервер и процесс-раннер), а пакет блоков попадает и в клиентскую сборку — иначе она падает на `net`.
 */
export function imapSmtpDriver(cfg: ImapSmtpConfig): MailDriver {
  const tls = { rejectUnauthorized: !cfg.tlsInsecure };
  const wrap = (e: unknown): never => {
    if (cfg.signal.aborted) throw new Error("Aborted", { cause: e });
    // причину не прикрепляем: в ней может оказаться пароль (CLAUDE.md, «Секреты»)
    throw new Error(redact(`Mail: ${e instanceof Error ? e.message : String(e)}`, [cfg.password]));
  };

  /** Одно соединение IMAP на вызов блока: открывается лениво, закрывается в `close`. */
  let imap: import("imapflow").ImapFlow | null = null;
  const connect = async () => {
    if (imap) return imap;
    const { ImapFlow } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "imapflow");
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
      logger: false,
      tls,
      socketTimeout: cfg.timeoutMs,
    });
    const onAbort = () => client.close();
    cfg.signal.addEventListener("abort", onAbort, { once: true });
    client.on("error", () => undefined); // ошибки приходят из вызовов, а не событием
    await client.connect();
    imap = client;
    return client;
  };

  return {
    async send(mail: OutMail) {
      try {
        const nodemailer = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "nodemailer");
        const transport = nodemailer.createTransport({
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          secure: cfg.smtpSecure,
          auth: { user: cfg.username, pass: cfg.password },
          tls,
          connectionTimeout: cfg.timeoutMs,
          socketTimeout: cfg.timeoutMs,
        });
        try {
          const info = await transport.sendMail({
            from: mail.from || cfg.username,
            to: mail.to,
            cc: mail.cc,
            bcc: mail.bcc,
            subject: mail.subject,
            ...(mail.html ? { html: mail.body } : { text: mail.body }),
          });
          return { ok: true, messageId: info.messageId ?? null, accepted: info.accepted.map(String), rejected: info.rejected.map(String) };
        } finally {
          transport.close();
        }
      } catch (e) {
        return wrap(e);
      }
    },

    async list(q: ListQuery) {
      try {
        const client = await connect();
        const lock = await client.getMailboxLock(q.folder);
        try {
          const found = await client.search(
            {
              ...(q.unreadOnly ? { seen: false } : {}),
              ...(q.from ? { from: q.from } : {}),
              ...(q.subject ? { subject: q.subject } : {}),
              ...(q.since ? { since: q.since } : {}),
            },
            { uid: true },
          );
          // новые — первыми: UID растут со временем
          const uids = (found || []).sort((a, b) => b - a).slice(0, q.limit);
          const items: MailItem[] = [];
          if (uids.length > 0) {
            for await (const m of client.fetch(uids, { envelope: true, flags: true, uid: true, internalDate: true }, { uid: true })) {
              items.push({
                id: String(m.uid),
                from: addr(m.envelope?.from?.[0]),
                to: (m.envelope?.to ?? []).map(addr).filter(Boolean),
                subject: m.envelope?.subject ?? "",
                date: m.internalDate ? new Date(m.internalDate).toISOString() : null,
                unread: !m.flags?.has("\\Seen"),
              });
            }
          }
          return items.sort((a, b) => Number(b.id) - Number(a.id));
        } finally {
          lock.release();
        }
      } catch (e) {
        return wrap(e);
      }
    },

    async get(folder: string, id: string) {
      try {
        const client = await connect();
        const lock = await client.getMailboxLock(folder);
        try {
          const m = await client.fetchOne(id, { source: true, flags: true, uid: true }, { uid: true });
          if (!m || !m.source) throw new Error(`message ${id} not found in ${folder}`);
          const { simpleParser } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "mailparser");
          const p = await simpleParser(m.source);
          const out: Json = {
            id,
            from: p.from?.text ?? "",
            to: p.to ? [p.to].flat().map((x) => x.text) : [],
            cc: p.cc ? [p.cc].flat().map((x) => x.text) : [],
            subject: p.subject ?? "",
            date: p.date ? p.date.toISOString() : null,
            unread: !m.flags?.has("\\Seen"),
            text: (p.text ?? "").slice(0, MAX_BODY_CHARS),
            html: typeof p.html === "string" ? p.html.slice(0, MAX_BODY_CHARS) : null,
            attachments: p.attachments.map((a) => ({ filename: a.filename ?? "", contentType: a.contentType, size: a.size })),
          };
          return out;
        } finally {
          lock.release();
        }
      } catch (e) {
        return wrap(e);
      }
    },

    async markRead(folder: string, id: string, read: boolean) {
      try {
        const client = await connect();
        const lock = await client.getMailboxLock(folder);
        try {
          if (read) await client.messageFlagsAdd(id, ["\\Seen"], { uid: true });
          else await client.messageFlagsRemove(id, ["\\Seen"], { uid: true });
          return { ok: true, id, read };
        } finally {
          lock.release();
        }
      } catch (e) {
        return wrap(e);
      }
    },

    async close() {
      const client = imap;
      imap = null;
      if (client) await client.logout().catch(() => client.close());
    },
  };
}

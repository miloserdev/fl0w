import type { Json } from "@fl0w/schema";
import { isPlainObject } from "./json-path";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL, MAX_BODY_CHARS, type ListQuery, type MailAttachment, type MailDriver, type MailItem, type OutMail } from "./mail-types";
import { MAX_RESPONSE_BYTES, readCapped } from "./http-request";
import { redact } from "./secrets";

/** Microsoft Graph and login addresses; the variables are needed for national clouds and tests (real Microsoft servers are not called in tests). */
export const GRAPH_URL_ENV = "FL0W_GRAPH_URL";
export const GRAPH_LOGIN_URL_ENV = "FL0W_GRAPH_LOGIN_URL";
const DEFAULT_GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_LOGIN = "https://login.microsoftonline.com";
const WELL_KNOWN: Record<string, string> = { inbox: "inbox", sent: "sentitems", sentitems: "sentitems", drafts: "drafts", trash: "deleteditems", deleteditems: "deleteditems", junk: "junkemail", archive: "archive" };
const SELECT_LIST = "id,subject,from,toRecipients,receivedDateTime,isRead";

export type GraphConfig = { tenantId: string; clientId: string; clientSecret: string; mailbox: string; timeoutMs: number; signal: AbortSignal };

const origin = (env: string, fallback: string) => (process.env[env] ?? fallback).replace(/\/+$/, "");
/** A string in an OData filter: single quotes are doubled. */
const odata = (s: string) => `'${s.replace(/'/g, "''")}'`;
const person = (r: Json | undefined): string => {
  const e = isPlainObject(r) && isPlainObject(r["emailAddress"]) ? r["emailAddress"] : null;
  const a = e && typeof e["address"] === "string" ? e["address"] : "";
  const n = e && typeof e["name"] === "string" ? e["name"] : "";
  return a ? (n && n !== a ? `${n} <${a}>` : a) : "";
};

/**
 * Microsoft Graph (Outlook / Microsoft 365): REST API with no extra libraries. Login is an Azure AD application
 * (client credentials: tenant, client id, client secret) with Mail.Read / Mail.ReadWrite / Mail.Send rights on the needed mailbox.
 */
export function graphDriver(cfg: GraphConfig): MailDriver {
  const secrets = [cfg.clientSecret];
  let token: string | null = null;
  const signal = AbortSignal.any([cfg.signal, AbortSignal.timeout(cfg.timeoutMs)]);

  const call = async (method: string, url: string, init: { body?: Json | URLSearchParams; headers?: Record<string, string> } = {}): Promise<Json> => {
    let res: Response;
    let raw: string;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body && !(init.body instanceof URLSearchParams) ? { "Content-Type": "application/json" } : {}), ...init.headers },
        body: init.body === undefined ? undefined : init.body instanceof URLSearchParams ? init.body : JSON.stringify(init.body),
        signal,
        redirect: "manual",
      });
      raw = res.status >= 300 && res.status < 400 ? "" : await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      if (cfg.signal.aborted) throw new Error("Aborted", { cause: e });
      if (e instanceof Error && e.name === "TimeoutError") throw new Error(`Mail request timed out after ${cfg.timeoutMs} ms`, { cause: e });
      // eslint-disable-next-line preserve-caught-error
      throw new Error(redact(`Mail request failed: ${e instanceof Error ? e.message : String(e)}`, secrets));
    }
    if (res.status >= 300 && res.status < 400) throw new Error(`Mail: unexpected redirect (HTTP ${res.status})`);
    if (!res.ok) {
      let detail = raw.slice(0, 300);
      try {
        const j = JSON.parse(raw) as Json;
        const msg = isPlainObject(j) && isPlainObject(j["error"]) ? (j["error"]["message"] ?? j["error"]["code"]) : isPlainObject(j) ? j["error_description"] : null;
        if (typeof msg === "string") detail = msg.slice(0, 300);
      } catch {
        // not JSON: keep the start of the body
      }
      throw new Error(redact(`Mail HTTP ${res.status} ${res.statusText}: ${detail}`, secrets).trim());
    }
    if (raw.trim() === "") return { ok: true };
    try {
      return JSON.parse(raw) as Json;
    } catch {
      throw new Error("Mail: response is not valid JSON");
    }
  };

  const auth = async () => {
    if (token) return;
    const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const res = await call("POST", `${origin(GRAPH_LOGIN_URL_ENV, DEFAULT_LOGIN)}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, { body });
    const t = isPlainObject(res) ? res["access_token"] : null;
    if (typeof t !== "string" || t === "") throw new Error("Mail: sign-in did not return an access token");
    secrets.push(t);
    token = t;
  };

  const user = () => `${origin(GRAPH_URL_ENV, DEFAULT_GRAPH)}/users/${encodeURIComponent(cfg.mailbox)}`;
  const folderPath = (folder: string) => `mailFolders/${encodeURIComponent(WELL_KNOWN[folder.trim().toLowerCase()] ?? folder)}`;
  const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
  const asItem = (m: Json): MailItem => {
    const o = isPlainObject(m) ? m : {};
    return {
      id: String(o["id"] ?? ""),
      from: person(o["from"]),
      to: Array.isArray(o["toRecipients"]) ? o["toRecipients"].map(person).filter(Boolean) : [],
      subject: typeof o["subject"] === "string" ? o["subject"] : "",
      date: typeof o["receivedDateTime"] === "string" ? o["receivedDateTime"] : null,
      unread: o["isRead"] === false,
    };
  };

  return {
    async send(mail: OutMail) {
      await auth();
      await call("POST", `${user()}/sendMail`, {
        body: {
          message: {
            subject: mail.subject,
            body: { contentType: mail.html ? "HTML" : "Text", content: mail.body },
            toRecipients: recipients(mail.to),
            ccRecipients: recipients(mail.cc),
            bccRecipients: recipients(mail.bcc),
            ...(mail.from ? { from: { emailAddress: { address: mail.from } } } : {}),
          },
          saveToSentItems: true,
        },
      });
      return { ok: true, accepted: [...mail.to, ...mail.cc, ...mail.bcc] };
    },

    async list(q: ListQuery) {
      await auth();
      // Graph requires the sort field to come first in the filter, so a date is always present
      const filter = [
        `receivedDateTime ge ${(q.since ?? new Date(0)).toISOString()}`,
        ...(q.unreadOnly ? ["isRead eq false"] : []),
        ...(q.from ? [`from/emailAddress/address eq ${odata(q.from)}`] : []),
        ...(q.subject ? [`contains(subject,${odata(q.subject)})`] : []),
      ].join(" and ");
      const url = `${user()}/${folderPath(q.folder)}/messages?${new URLSearchParams({ $top: String(q.limit), $select: SELECT_LIST, $orderby: "receivedDateTime desc", $filter: filter })}`;
      const res = await call("GET", url);
      const items = isPlainObject(res) && Array.isArray(res["value"]) ? res["value"] : [];
      return items.map(asItem);
    },

    async get(_folder: string, id: string) {
      await auth();
      const m = await call("GET", `${user()}/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: `${SELECT_LIST},ccRecipients,body,hasAttachments` })}`);
      const o = isPlainObject(m) ? m : {};
      const body = isPlainObject(o["body"]) ? o["body"] : {};
      const content = typeof body["content"] === "string" ? body["content"].slice(0, MAX_BODY_CHARS) : "";
      const isHtml = body["contentType"] === "html";
      let attachments: Json[] = [];
      if (o["hasAttachments"] === true) {
        const a = await call("GET", `${user()}/messages/${encodeURIComponent(id)}/attachments?${new URLSearchParams({ $select: "name,contentType,size" })}`);
        attachments = (isPlainObject(a) && Array.isArray(a["value"]) ? a["value"] : []).map((x) => (isPlainObject(x) ? { filename: x["name"] ?? "", contentType: x["contentType"] ?? "", size: x["size"] ?? 0 } : { filename: "", contentType: "", size: 0 }));
      }
      return {
        ...asItem(m),
        cc: Array.isArray(o["ccRecipients"]) ? o["ccRecipients"].map(person).filter(Boolean) : [],
        text: isHtml ? "" : content,
        html: isHtml ? content : null,
        attachments,
      };
    },

    async markRead(_folder: string, id: string, read: boolean) {
      await auth();
      await call("PATCH", `${user()}/messages/${encodeURIComponent(id)}`, { body: { isRead: read } });
      return { ok: true, id, read };
    },

    async reply(_folder: string, id: string, body: string, html: boolean, all: boolean) {
      await auth();
      await call("POST", `${user()}/messages/${encodeURIComponent(id)}/${all ? "replyAll" : "reply"}`, {
        body: html ? { message: { body: { contentType: "HTML", content: body } } } : { comment: body },
      });
      return { ok: true, id, all };
    },

    async move(_folder: string, id: string, destination: string) {
      await auth();
      const dest = WELL_KNOWN[destination.trim().toLowerCase()] ?? destination;
      const moved = await call("POST", `${user()}/messages/${encodeURIComponent(id)}/move`, { body: { destinationId: dest } });
      return { ok: true, id: isPlainObject(moved) && typeof moved["id"] === "string" ? moved["id"] : id, destination };
    },

    async attachments(_folder: string, id: string): Promise<MailAttachment[]> {
      await auth();
      const res = await call("GET", `${user()}/messages/${encodeURIComponent(id)}/attachments?${new URLSearchParams({ $select: "name,contentType,size,contentBytes" })}`);
      const items = isPlainObject(res) && Array.isArray(res["value"]) ? res["value"] : [];
      let total = 0;
      const out: MailAttachment[] = [];
      for (const x of items) {
        // file attachments only: nested messages and links have no contentBytes
        if (!isPlainObject(x) || typeof x["contentBytes"] !== "string") continue;
        const bytes = Buffer.from(x["contentBytes"], "base64");
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Mail: attachment "${String(x["name"] ?? "")}" is too large`);
        total += bytes.byteLength;
        if (total > MAX_ATTACHMENT_TOTAL) throw new Error("Mail: attachments are too large");
        out.push({ filename: typeof x["name"] === "string" ? x["name"] : "", contentType: typeof x["contentType"] === "string" ? x["contentType"] : "", size: bytes.byteLength, bytes });
      }
      return out;
    },

    async close() {
      // no session: the token is short-lived and not stored
    },
  };
}

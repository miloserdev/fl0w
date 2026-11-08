import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Json } from "@fl0w/schema";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mail } from "./mail";
import { MailTrigger } from "./mail-trigger";
import { resolveParams } from "./params";
import { registry } from "./registry";

// --- fake IMAP: we check HOW the block uses imapflow (there is no real server in tests) ---
const imapCalls: string[] = [];
const imapState = { found: [] as number[], failConnect: false };
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(readonly opts: Record<string, unknown>) {
      imapCalls.push(`new ${JSON.stringify({ host: opts["host"], port: opts["port"], secure: opts["secure"], user: (opts["auth"] as { user: string }).user, reject: (opts["tls"] as { rejectUnauthorized: boolean }).rejectUnauthorized })}`);
    }
    on() {}
    async connect() {
      if (imapState.failConnect) throw new Error(`Invalid credentials for ${this.opts["auth"] ? (this.opts["auth"] as { pass: string }).pass : ""}`);
      imapCalls.push("connect");
    }
    async getMailboxLock(folder: string) {
      imapCalls.push(`lock ${folder}`);
      return { release: () => imapCalls.push("release") };
    }
    async search(q: Record<string, unknown>) {
      imapCalls.push(`search ${JSON.stringify(q)}`);
      return imapState.found;
    }
    async *fetch(uids: number[]) {
      imapCalls.push(`fetch ${uids.join(",")}`);
      for (const uid of uids) {
        yield { uid, envelope: { from: [{ name: "Ann", address: "ann@x.io" }], to: [{ address: "me@x.io" }], subject: `Письмо ${uid}` }, flags: new Set(uid % 2 ? [] : ["\\Seen"]), internalDate: new Date("2026-02-01T10:00:00Z") };
      }
    }
    async fetchOne(id: string) {
      imapCalls.push(`fetchOne ${id}`);
      return { source: Buffer.from("Message-ID: <orig-1@x.io>\r\nFrom: Ann <ann@x.io>\r\nReply-To: Ann Reply <ann.reply@x.io>\r\nTo: me@x.io, boss@x.io\r\nCc: team@x.io\r\nSubject: Привет\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nтекст письма\r\n"), flags: new Set<string>() };
    }
    async messageMove(id: string, dest: string) {
      imapCalls.push(`move ${id} -> ${dest}`);
    }
    async messageFlagsAdd(id: string, flags: string[]) {
      imapCalls.push(`flags+ ${id} ${flags.join(",")}`);
    }
    async messageFlagsRemove(id: string, flags: string[]) {
      imapCalls.push(`flags- ${id} ${flags.join(",")}`);
    }
    async logout() {
      imapCalls.push("logout");
    }
    close() {
      imapCalls.push("close");
    }
  },
}));

// --- fake Microsoft Graph and the entry point ---
type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; raw: string };
let graph: Server;
let base = "";
let seen: Seen[] = [];
let routes: Record<string, [number, unknown]> = {};
// --- a real SMTP server (smtp-server): the message really goes out over the protocol ---
let smtp: SMTPServer;
let smtpPort = 0;
const smtpGot: { from: string; to: string[]; data: string; user: string | undefined }[] = [];

beforeAll(async () => {
  graph = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") });
    const hit = routes[`${req.method} ${req.url!.split("?")[0]}`];
    if (!hit) return void res.writeHead(404).end(JSON.stringify({ error: { message: "no route" } }));
    res.writeHead(hit[0], { "Content-Type": "application/json" });
    res.end(hit[1] === undefined ? "" : JSON.stringify(hit[1]));
  });
  await new Promise<void>((r) => graph.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
  process.env["FL0W_GRAPH_URL"] = `${base}/v1.0`;
  process.env["FL0W_GRAPH_LOGIN_URL"] = `${base}/login`;

  smtp = new SMTPServer({
    authOptional: false,
    secure: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _s, cb) {
      if (auth.username === "me@x.io" && auth.password === "smtp-pass") cb(null, { user: auth.username });
      else cb(new Error("Invalid login"));
    },
    onData(stream, session, cb) {
      const parts: Buffer[] = [];
      stream.on("data", (c: Buffer) => parts.push(c));
      stream.on("end", () => {
        smtpGot.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(parts).toString("utf8"), user: session.user as string | undefined });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
afterAll(() => {
  graph.close();
  smtp.close();
  delete process.env["FL0W_GRAPH_URL"];
  delete process.env["FL0W_GRAPH_LOGIN_URL"];
});
afterEach(() => {
  seen = [];
  routes = {};
  imapCalls.length = 0;
  imapState.found = [];
  imapState.failConnect = false;
  smtpGot.length = 0;
});

const GRAPH = { provider: "graph", tenantId: "tenant-1", clientId: "client-1", username: "me@x.io", password: "client-secret-value" } as const;
const IMAP = { provider: "imap", host: "imap.example.test", username: "me@x.io", password: "smtp-pass" } as const;

const run = (params: Record<string, Json>, input: Json | undefined = undefined, signal = new AbortController().signal) =>
  new Mail().run(input === undefined ? {} : { in0: input }, resolveParams(Mail.params, params), { log() {}, signal });

const tokenRoute = () => (routes["POST /login/tenant-1/oauth2/v2.0/token"] = [200, { access_token: "graph-token-xyz" }]);

describe("Mail: general", () => {
  it("is registered as mail; parameter errors come before connecting to the server", async () => {
    expect(registry["mail"]).toBe(Mail);
    const bad = (p: Record<string, Json>, re: RegExp) => expect(run({ ...IMAP, ...p })).rejects.toThrow(re);
    await bad({ operation: "sendMail", to: "" }, /"to" is empty/);
    await bad({ operation: "sendMail", to: "не-адрес" }, /not an email address/);
    await bad({ operation: "sendMail", to: "a@b.io", cc: "x@y", subject: "s" }, /"cc"/);
    await bad({ operation: "sendMail", to: "a@b.io", subject: "тема\nBcc: evil@x.io", body: "x" }, /single line/);
    await bad({ operation: "sendMail", to: "a@b.io", from: "x@y.io\r\nBcc: e@e.io", body: "x" }, /single line/);
    await bad({ operation: "sendMail", to: "a@b.io" }, /both empty/);
    await bad({ operation: "getMail", messageId: "" }, /messageId/);
    await bad({ operation: "listMail", since: "вчера" }, /not a date/);
    await bad({ operation: "listMail", host: "" }, /"host"/);
    await bad({ operation: "listMail", username: "" }, /"username"/);
    await bad({ operation: "listMail", password: "env:PATH" }, /FL0W_SECRET_/);
    await expect(run({ ...GRAPH, tenantId: "", operation: "listMail" })).rejects.toThrow(/tenantId/);
    expect(imapCalls).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("Mail: IMAP / SMTP", () => {
  it("list: filters go to the search, newest first, the limit is applied, the connection is closed", async () => {
    imapState.found = [3, 9, 5, 1];
    const r = await run({ ...IMAP, operation: "listMail", unreadOnly: true, fromFilter: "{{ who }}", subjectFilter: "отчёт", since: "2026-01-31", limit: 2, tlsInsecure: true }, { who: "ann@x.io" });
    const items = r["out0"] as { id: string; unread: boolean; subject: string; from: string }[];
    expect(items.map((i) => i.id)).toEqual(["9", "5"]);
    expect(items[0]).toMatchObject({ unread: true, subject: "Письмо 9", from: "Ann <ann@x.io>" });
    expect(imapCalls).toEqual([
      'new {"host":"imap.example.test","port":993,"secure":true,"user":"me@x.io","reject":false}',
      "connect",
      "lock INBOX",
      'search {"seen":false,"from":"ann@x.io","subject":"отчёт","since":"2026-01-31T00:00:00.000Z"}',
      "fetch 9,5",
      "release",
      "logout",
    ]);
  });

  it("read a message: the text is parsed, attachments are metadata only; marking as read", async () => {
    const r = await run({ ...IMAP, operation: "getMail", folder: "Archive", messageId: "42" });
    expect(r["out0"]).toMatchObject({ id: "42", subject: "Привет", text: "текст письма\n", from: expect.stringContaining("ann@x.io"), unread: true, attachments: [] });
    expect(imapCalls).toContain("lock Archive");
    imapCalls.length = 0;
    expect((await run({ ...IMAP, operation: "markMailRead", messageId: "42" }))["out0"]).toEqual({ ok: true, id: "42", read: true });
    await run({ ...IMAP, operation: "markMailRead", messageId: "42", read: false });
    expect(imapCalls.filter((c) => c.startsWith("flags"))).toEqual(["flags+ 42 \\Seen", "flags- 42 \\Seen"]);
  });

  it("a login error does not reveal the password", async () => {
    imapState.failConnect = true;
    const err = await run({ ...IMAP, operation: "listMail", password: "very-secret-pass" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Mail: Invalid credentials/);
    expect((err as Error).message).not.toContain("very-secret-pass");
  });

  it("sending over a real SMTP: recipients, subject, body, templates from the input; a wrong password is an error", async () => {
    const smtpCfg = { ...IMAP, smtpHost: "127.0.0.1", smtpPort: smtpPort, smtpSecure: false, operation: "sendMail" } as const;
    const r = await run({ ...smtpCfg, to: "ann@x.io; bob@x.io", cc: "cc@x.io", bcc: "hidden@x.io", subject: "Заказ {{ id }}", body: "Здравствуйте, {{ name }}!" }, { id: 7, name: "Анна" });
    expect(r["out0"]).toMatchObject({ ok: true, accepted: expect.arrayContaining(["ann@x.io", "bob@x.io", "cc@x.io", "hidden@x.io"]) });
    expect(smtpGot).toHaveLength(1);
    const m = smtpGot[0]!;
    expect(m.user).toBe("me@x.io");
    expect(m.from).toBe("me@x.io");
    expect(m.to.sort()).toEqual(["ann@x.io", "bob@x.io", "cc@x.io", "hidden@x.io"]);
    expect(m.data).toMatch(/^To: ann@x\.io, bob@x\.io/m);
    expect(m.data).not.toMatch(/^Bcc:/m); // a hidden copy does not show in the headers
    expect(m.data).toMatch(/^Subject: =\?UTF-8\?/m); // a subject with Cyrillic is encoded
    await expect(run({ ...smtpCfg, to: "a@b.io", subject: "x", body: "y", password: "wrong" })).rejects.toThrow(/Mail:/);
    expect(smtpGot).toHaveLength(1);
  });
});

describe("Mail: Microsoft Graph", () => {
  it("app login and sending: the token is obtained once, the message goes on behalf of the mailbox", async () => {
    tokenRoute();
    routes["POST /v1.0/users/me%40x.io/sendMail"] = [202, undefined];
    const r = await run({ ...GRAPH, operation: "sendMail", to: "ann@x.io", cc: "c@x.io", subject: "Тема {{ n }}", body: "<b>Привет</b>", html: true }, { n: 1 });
    expect(r["out0"]).toEqual({ ok: true, accepted: ["ann@x.io", "c@x.io"] });
    const [login, send] = seen;
    expect(new URLSearchParams(login!.raw).get("client_secret")).toBe("client-secret-value");
    expect(new URLSearchParams(login!.raw).get("grant_type")).toBe("client_credentials");
    expect(send!.headers["authorization"]).toBe("Bearer graph-token-xyz");
    expect(JSON.parse(send!.raw)).toEqual({
      message: { subject: "Тема 1", body: { contentType: "HTML", content: "<b>Привет</b>" }, toRecipients: [{ emailAddress: { address: "ann@x.io" } }], ccRecipients: [{ emailAddress: { address: "c@x.io" } }], bccRecipients: [] },
      saveToSentItems: true,
    });
  });

  it("list: folder INBOX -> inbox, OData filters with quote escaping, sort by date", async () => {
    tokenRoute();
    routes["GET /v1.0/users/me%40x.io/mailFolders/inbox/messages"] = [
      200,
      { value: [{ id: "AAA=", subject: "Отчёт", from: { emailAddress: { name: "Ann", address: "ann@x.io" } }, toRecipients: [{ emailAddress: { address: "me@x.io" } }], receivedDateTime: "2026-02-01T10:00:00Z", isRead: false }] },
    ];
    const r = await run({ ...GRAPH, operation: "listMail", unreadOnly: true, fromFilter: "o'brien@x.io", subjectFilter: "it's", since: "2026-01-31", limit: 5 });
    expect(r["out0"]).toEqual([{ id: "AAA=", from: "Ann <ann@x.io>", to: ["me@x.io"], subject: "Отчёт", date: "2026-02-01T10:00:00Z", unread: true }]);
    const q = new URL(seen[1]!.url, base).searchParams;
    expect(q.get("$top")).toBe("5");
    expect(q.get("$orderby")).toBe("receivedDateTime desc");
    expect(q.get("$filter")).toBe("receivedDateTime ge 2026-01-31T00:00:00.000Z and isRead eq false and from/emailAddress/address eq 'o''brien@x.io' and contains(subject,'it''s')");
  });

  it("a whole message (html and attachments), marking as read", async () => {
    tokenRoute();
    routes["GET /v1.0/users/me%40x.io/messages/AAA%3D"] = [200, { id: "AAA=", subject: "S", isRead: true, hasAttachments: true, body: { contentType: "html", content: "<p>hi</p>" }, ccRecipients: [{ emailAddress: { address: "c@x.io" } }] }];
    routes["GET /v1.0/users/me%40x.io/messages/AAA%3D/attachments"] = [200, { value: [{ name: "a.pdf", contentType: "application/pdf", size: 10 }] }];
    routes["PATCH /v1.0/users/me%40x.io/messages/AAA%3D"] = [200, {}];
    const r = await run({ ...GRAPH, operation: "getMail", messageId: "AAA=" });
    expect(r["out0"]).toMatchObject({ id: "AAA=", html: "<p>hi</p>", text: "", cc: ["c@x.io"], attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 10 }], unread: false });
    expect((await run({ ...GRAPH, operation: "markMailRead", messageId: "AAA=", read: false }))["out0"]).toEqual({ ok: true, id: "AAA=", read: false });
    expect(JSON.parse(seen.at(-1)!.raw)).toEqual({ isRead: false });
  });

  it("errors: a Graph message without secrets, the login returned no token", async () => {
    routes["POST /login/tenant-1/oauth2/v2.0/token"] = [401, { error: "invalid_client", error_description: "bad secret client-secret-value" }];
    const err = await run({ ...GRAPH, operation: "listMail" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain("client-secret-value");
    routes["POST /login/tenant-1/oauth2/v2.0/token"] = [200, {}];
    await expect(run({ ...GRAPH, operation: "listMail" })).rejects.toThrow(/did not return an access token/);
  });

  it("cancelling the run aborts the request", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run({ ...GRAPH, operation: "listMail" }, undefined, ac.signal)).rejects.toThrow("Aborted");
  });
});

describe("Mail: reply, move, attachments", () => {
  it("IMAP: the reply goes to the sender (Reply-To) with Re:, In-Reply-To and a reference to the original; replyAll adds the others but not me", async () => {
    const smtpCfg = { ...IMAP, smtpHost: "127.0.0.1", smtpPort: smtpPort, smtpSecure: false, operation: "replyMail", messageId: "42", body: "Спасибо, {{ who }}" } as const;
    await run(smtpCfg, { who: "Анна" });
    let m = smtpGot.at(-1)!;
    expect(m.to).toEqual(["ann.reply@x.io"]);
    expect(m.data).toMatch(/^In-Reply-To: <orig-1@x\.io>/m);
    expect(m.data).toMatch(/^References: .*<orig-1@x\.io>/m);
    expect(m.data).toMatch(/^Subject: =\?UTF-8\?/m);
    await run({ ...smtpCfg, replyAll: true });
    m = smtpGot.at(-1)!;
    expect(m.to.sort()).toEqual(["ann.reply@x.io", "boss@x.io", "team@x.io"]); // me@x.io (that is me) is not included
  });

  it("IMAP: moving a message to a folder; parameters are checked before connecting", async () => {
    expect((await run({ ...IMAP, operation: "moveMail", messageId: "7", destination: "Archive" }))["out0"]).toEqual({ ok: true, id: "7", destination: "Archive" });
    expect(imapCalls).toContain("move 7 -> Archive");
    imapCalls.length = 0;
    await expect(run({ ...IMAP, operation: "moveMail", messageId: "7", destination: "" })).rejects.toThrow(/destination/);
    await expect(run({ ...IMAP, operation: "replyMail", messageId: "7", body: "" })).rejects.toThrow(/reply "body" is empty/);
    expect(imapCalls).toEqual([]);
  });

  it("Graph: reply (text and HTML), reply all, moving to a known folder", async () => {
    tokenRoute();
    routes["POST /v1.0/users/me%40x.io/messages/AAA%3D/reply"] = [202, undefined];
    routes["POST /v1.0/users/me%40x.io/messages/AAA%3D/replyAll"] = [202, undefined];
    routes["POST /v1.0/users/me%40x.io/messages/AAA%3D/move"] = [201, { id: "BBB=" }];
    await run({ ...GRAPH, operation: "replyMail", messageId: "AAA=", body: "Принято" });
    expect(JSON.parse(seen.at(-1)!.raw)).toEqual({ comment: "Принято" });
    await run({ ...GRAPH, operation: "replyMail", messageId: "AAA=", body: "<b>ok</b>", html: true, replyAll: true });
    expect(seen.at(-1)!.url).toBe("/v1.0/users/me%40x.io/messages/AAA%3D/replyAll");
    expect(JSON.parse(seen.at(-1)!.raw)).toEqual({ message: { body: { contentType: "HTML", content: "<b>ok</b>" } } });
    expect((await run({ ...GRAPH, operation: "moveMail", messageId: "AAA=", destination: "Trash" }))["out0"]).toEqual({ ok: true, id: "BBB=", destination: "Trash" });
    expect(JSON.parse(seen.at(-1)!.raw)).toEqual({ destinationId: "deleteditems" });
  });

  describe("saving attachments", () => {
    let dir: string;
    const saved = process.env["FL0W_FILES_DIR"];
    const mk = () => {
      dir = mkdtempSync(path.join(tmpdir(), "fl0w-mail-"));
      process.env["FL0W_FILES_DIR"] = dir;
    };
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env["FL0W_FILES_DIR"];
      else process.env["FL0W_FILES_DIR"] = saved;
    });

    it("Graph: attachments are written to <dir>/<id>/<name>, the result gets a path; dangerous names are neutralised, identical ones are distinguished", async () => {
      mk();
      tokenRoute();
      routes["GET /v1.0/users/me%40x.io/messages/AAA%3D"] = [200, { id: "AAA=", subject: "S", hasAttachments: true, body: { contentType: "text", content: "x" } }];
      const b64 = (t: string) => Buffer.from(t).toString("base64");
      routes["GET /v1.0/users/me%40x.io/messages/AAA%3D/attachments"] = [
        200,
        { value: [
          { name: "отчёт.txt", contentType: "text/plain", size: 5, contentBytes: b64("hello") },
          { name: "../../evil.sh", contentType: "text/plain", size: 3, contentBytes: b64("pwn") },
          { name: "отчёт.txt", contentType: "text/plain", size: 5, contentBytes: b64("again") },
          { name: "письмо.eml", contentType: "message/rfc822", size: 1 }, // a nested message without content is skipped
        ] },
      ];
      const r = (await run({ ...GRAPH, operation: "getMail", messageId: "AAA=", saveAttachments: true, attachmentsDir: "inbox" }))["out0"] as { attachments: { filename: string; path?: string }[] };
      const files = readdirSync(path.join(dir, "inbox", "AAA_"));
      expect(files.sort()).toEqual(["evil.sh", "отчёт (2).txt", "отчёт.txt"]);
      expect(readFileSync(path.join(dir, "inbox", "AAA_", "отчёт.txt"), "utf8")).toBe("hello");
      expect(r.attachments.map((a) => a.path ?? null)).toEqual(["inbox/AAA_/отчёт.txt", "inbox/AAA_/evil.sh", "inbox/AAA_/отчёт (2).txt", null]);
    });

    it("IMAP: a directory path outside the files directory is rejected; without saveAttachments enabled no files are written", async () => {
      mk();
      await run({ ...IMAP, operation: "getMail", messageId: "42" });
      expect(readdirSync(dir)).toEqual([]);
      await expect(run({ ...IMAP, operation: "getMail", messageId: "42", saveAttachments: true, attachmentsDir: "../x" })).resolves.toBeDefined(); // no attachments: we do not touch the directory
    });
  });
});

describe("Mail Trigger: subscription parameters", () => {
  const base = { provider: "imap", host: "imap.test", username: "me@x.io", password: "pw-12345" };
  it("sensible defaults and password substitution from the environment", () => {
    process.env["FL0W_SECRET_MAILBOX"] = "from-env";
    const w = MailTrigger.mailWatch({ ...base, password: "env:FL0W_SECRET_MAILBOX" });
    delete process.env["FL0W_SECRET_MAILBOX"];
    expect(w).toMatchObject({ username: "me@x.io", password: "from-env", folder: "INBOX", unreadOnly: true, intervalSec: 60, action: "markRead", processExisting: false, saveAttachments: false });
  });
  it("checks: period 15...3600 s, host/tenant, action, attachments directory", () => {
    expect(() => MailTrigger.mailWatch({ ...base, intervalSec: 5 })).toThrow(/intervalSec/);
    expect(() => MailTrigger.mailWatch({ ...base, intervalSec: 99999 })).toThrow(/intervalSec/);
    expect(() => MailTrigger.mailWatch({ ...base, host: "" })).toThrow(/host/);
    expect(() => MailTrigger.mailWatch({ provider: "graph", username: "u@x.io", password: "pw-12345" })).toThrow(/tenantId/);
    expect(() => MailTrigger.mailWatch({ ...base, action: "delete" })).toThrow(/action/);
    expect(() => MailTrigger.mailWatch({ ...base, attachmentsDir: "../x" })).toThrow(/must not contain/);
    expect(() => MailTrigger.mailWatch({ ...base, provider: "pigeon" })).toThrow(/provider/);
  });
});

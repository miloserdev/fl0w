import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { Atlassian } from "./atlassian";
import { resolveParams } from "./params";
import { registry } from "./registry";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Json | null; raw: string };
let server: Server;
let base = "";
let seen: Seen[] = [];
/** Что отвечает поддельная Jira: по «метод путь» → [статус, тело, заголовки]. */
let routes: Record<string, [number, unknown, Record<string, string | string[]>?]> = {};

const TOKEN = "s3cr3t-token-value";
const saved = process.env["FL0W_SECRET_JIRA_TEST"];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw && String(req.headers["content-type"]).includes("json") ? (JSON.parse(raw) as Json) : null, raw });
    const hit = routes[`${req.method} ${req.url!.split("?")[0]}`];
    if (!hit) return void res.writeHead(404).end(JSON.stringify({ errorMessages: ["no route"] }));
    const [status, body, headers] = hit;
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());
afterEach(() => {
  seen = [];
  routes = {};
  if (saved === undefined) delete process.env["FL0W_SECRET_JIRA_TEST"];
  else process.env["FL0W_SECRET_JIRA_TEST"] = saved;
});

const run = (params: Record<string, Json>, input: Json | undefined = undefined, signal = new AbortController().signal) => {
  process.env["FL0W_SECRET_JIRA_TEST"] = TOKEN;
  return new Atlassian().run(input === undefined ? {} : { in0: input }, resolveParams(Atlassian.params, { auth: "basic", baseUrl: base, username: "bob", password: "env:FL0W_SECRET_JIRA_TEST", ...params }), { log() {}, signal });
};

describe("Atlassian (Jira)", () => {
  it("зарегистрирован как atlassian", () => {
    expect(registry["atlassian"]).toBe(Atlassian);
  });

  it("searchIssues: Basic-вход, JQL с подстановкой из входа, поля и лимит", async () => {
    routes["POST /rest/api/2/search"] = [200, { total: 1, issues: [{ key: "ABC-1" }] }];
    const r = await run({ operation: "searchIssues", jql: "project = {{ proj }} ORDER BY created", fields: ["summary", "status"], maxResults: 10 }, { proj: "ABC" });
    expect(r).toEqual({ out0: { total: 1, issues: [{ key: "ABC-1" }] } });
    expect(seen[0]!.headers["authorization"]).toBe(`Basic ${Buffer.from(`bob:${TOKEN}`).toString("base64")}`);
    expect(seen[0]!.body).toEqual({ jql: "project = ABC ORDER BY created", maxResults: 10, fields: ["summary", "status"] });
  });

  it("form: вход логином и паролем через login.jsp (как в браузере), cookie на вызов, выход в конце — без токена", async () => {
    routes["POST /login.jsp"] = [200, undefined, { "X-Seraph-LoginReason": "OK", "Set-Cookie": ["JSESSIONID=form-sess-9; Path=/; HttpOnly", "atlassian.xsrf.token=xsrf-1_lin; Path=/", "gone=; Max-Age=0"] }];
    routes["POST /rest/api/2/search"] = [200, { total: 0, issues: [] }];
    routes["DELETE /rest/auth/1/session"] = [204, undefined];
    expect(await run({ auth: "form", operation: "searchIssues", jql: "assignee = currentUser()" })).toEqual({ out0: { total: 0, issues: [] } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /login.jsp", "POST /rest/api/2/search", "DELETE /rest/auth/1/session"]);
    expect(new URLSearchParams(seen[0]!.raw).get("os_username")).toBe("bob");
    expect(new URLSearchParams(seen[0]!.raw).get("os_password")).toBe(TOKEN);
    expect(new URLSearchParams(seen[0]!.raw).get("login")).toBe("Log In");
    expect(seen[1]!.headers["cookie"]).toBe("JSESSIONID=form-sess-9; atlassian.xsrf.token=xsrf-1_lin");
    expect(seen[1]!.headers["authorization"]).toBeUndefined();
  });

  it("form: неверный пароль / капча — понятная ошибка без пароля; нет сессии — тоже ошибка", async () => {
    routes["POST /login.jsp"] = [200, undefined, { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" }];
    const err = await run({ auth: "form", operation: "getIssue", issueKey: "A-1" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/login failed \(AUTHENTICATED_FAILED\).*CAPTCHA/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(seen.map((s) => s.url)).toEqual(["/login.jsp"]);
    routes["POST /login.jsp"] = [200, undefined, { "X-Seraph-LoginReason": "OK" }];
    await expect(run({ auth: "form", operation: "getIssue", issueKey: "A-1" })).rejects.toThrow(/did not return a session/);
  });

  it("по умолчанию режим входа — форма (логин и пароль)", () => {
    expect(resolveParams(Atlassian.params, { baseUrl: base })["auth"]).toBe("form");
  });

  it("пароль, введённый текстом, не попадает в сообщение об ошибке", async () => {
    routes["POST /rest/api/2/search"] = [401, { errorMessages: ["wrong plain-password here"] }];
    const err = await run({ password: "plain-password", operation: "searchIssues", jql: "x = 1" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain("plain-password");
  });

  it("bearer: персональный токен в заголовке, имя пользователя не нужно", async () => {
    routes["GET /rest/api/2/issue/ABC-7"] = [200, { key: "ABC-7" }];
    expect(await run({ auth: "bearer", username: "", operation: "getIssue", issueKey: "ABC-7", fields: ["summary"] })).toEqual({ out0: { key: "ABC-7" } });
    expect(seen[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.url).toBe("/rest/api/2/issue/ABC-7?fields=summary");
  });

  it("session: вход через REST, cookie на вызов, выход в конце", async () => {
    routes["POST /rest/auth/1/session"] = [200, { session: { name: "JSESSIONID", value: "sess-abc-123" } }];
    routes["GET /rest/api/2/issue/ABC-1"] = [200, { key: "ABC-1" }];
    routes["DELETE /rest/auth/1/session"] = [204, undefined];
    expect(await run({ auth: "session", operation: "getIssue", issueKey: "ABC-1" })).toEqual({ out0: { key: "ABC-1" } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /rest/auth/1/session", "GET /rest/api/2/issue/ABC-1", "DELETE /rest/auth/1/session"]);
    expect(seen[0]!.body).toEqual({ username: "bob", password: TOKEN });
    expect(seen[1]!.headers["cookie"]).toBe("JSESSIONID=sess-abc-123");
    expect(seen[1]!.headers["authorization"]).toBeUndefined();
  });

  it("session: сессия гасится и при ошибке операции", async () => {
    routes["POST /rest/auth/1/session"] = [200, { session: { name: "JSESSIONID", value: "sess-abc-123" } }];
    routes["GET /rest/api/2/issue/ABC-1"] = [404, { errorMessages: ["Issue does not exist"] }];
    routes["DELETE /rest/auth/1/session"] = [204, undefined];
    await expect(run({ auth: "session", operation: "getIssue", issueKey: "ABC-1" })).rejects.toThrow(/HTTP 404/);
    expect(seen.at(-1)!.method).toBe("DELETE");
  });

  it("createIssue: поля задачи, описание обычным текстом в v2 и ADF в v3, extraFields", async () => {
    routes["POST /rest/api/2/issue"] = [201, { key: "ABC-9" }];
    routes["POST /rest/api/3/issue"] = [201, { key: "ABC-10" }];
    const p = { operation: "createIssue", project: "ABC", issueType: "Bug", summary: "Сломано {{ what }}", description: "строка 1\n\nстрока 2", extraFields: { labels: ["flow"] } } satisfies Record<string, Json>;
    await run(p, { what: "всё" });
    expect(seen[0]!.body).toEqual({ fields: { labels: ["flow"], project: { key: "ABC" }, issuetype: { name: "Bug" }, summary: "Сломано всё", description: "строка 1\n\nстрока 2" } });
    await run({ ...p, apiVersion: "3" }, { what: "всё" });
    expect((seen[1]!.body as { fields: { description: Json } }).fields.description).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "строка 1" }] },
        { type: "paragraph", content: [{ type: "text", text: "строка 2" }] },
      ],
    });
  });

  it("updateIssue / addComment / transitionIssue (по имени и по id)", async () => {
    routes["PUT /rest/api/2/issue/ABC-1"] = [204, undefined];
    expect(await run({ operation: "updateIssue", issueKey: "ABC-1", summary: "Новое" })).toEqual({ out0: { ok: true, key: "ABC-1" } });
    expect(seen[0]!.body).toEqual({ fields: { summary: "Новое" } });
    routes["POST /rest/api/2/issue/ABC-1/comment"] = [201, { id: "10" }];
    expect(await run({ operation: "addComment", issueKey: "ABC-1", comment: "готово" })).toEqual({ out0: { id: "10" } });
    routes["GET /rest/api/2/issue/ABC-1/transitions"] = [200, { transitions: [{ id: "31", name: "Done" }, { id: "21", name: "In Progress" }] }];
    routes["POST /rest/api/2/issue/ABC-1/transitions"] = [204, undefined];
    expect(await run({ operation: "transitionIssue", issueKey: "ABC-1", transition: "done" })).toEqual({ out0: { ok: true, key: "ABC-1", transition: "31" } });
    expect(seen.at(-1)!.body).toEqual({ transition: { id: "31" } });
    expect(await run({ operation: "transitionIssue", issueKey: "ABC-1", transition: "21" })).toEqual({ out0: { ok: true, key: "ABC-1", transition: "21" } });
    await expect(run({ operation: "transitionIssue", issueKey: "ABC-1", transition: "Nope" })).rejects.toThrow(/no transition "Nope".*Done, In Progress/);
  });

  it("request: произвольный путь на тот же сайт; тело по умолчанию — вход", async () => {
    routes["GET /rest/api/content"] = [200, { results: [] }];
    routes["POST /rest/api/content"] = [200, { id: "1" }];
    expect(await run({ operation: "request", method: "GET", path: "/rest/api/content?spaceKey=DOC" })).toEqual({ out0: { results: [] } });
    expect(seen[0]!.url).toBe("/rest/api/content?spaceKey=DOC");
    await run({ operation: "request", method: "POST", path: "/rest/api/content" }, { title: "T" });
    expect(seen[1]!.body).toEqual({ title: "T" });
  });

  it("защита адреса: путь не может сменить хост, выйти вверх или содержать схему; baseUrl без учётных данных", async () => {
    for (const path of ["//evil.example/x", "http://evil.example/x", "/a/../b", "rest/api", "/a b", "/a#b"]) {
      await expect(run({ operation: "request", path })).rejects.toThrow(/"path" must start/);
    }
    expect(seen).toHaveLength(0);
    await expect(run({ baseUrl: "http://u:p@host" })).rejects.toThrow(/credentials/);
    await expect(run({ baseUrl: "ftp://host" })).rejects.toThrow(/http\(s\)/);
    await expect(run({ baseUrl: "не url" })).rejects.toThrow(/valid URL/);
  });

  it("секрет: пароль можно ввести текстом; ссылка env: — на чужую или не заданную переменную и пустой пароль дают понятные ошибки", async () => {
    routes["GET /rest/api/2/issue/ABC-1"] = [200, { key: "ABC-1" }];
    await run({ password: "plain-password", operation: "getIssue", issueKey: "ABC-1" });
    expect(seen[0]!.headers["authorization"]).toBe(`Basic ${Buffer.from("bob:plain-password").toString("base64")}`);
    seen = [];
    await expect(run({ password: "env:PATH" })).rejects.toThrow(/FL0W_SECRET_/);
    await expect(run({ password: "env:FL0W_SECRET_NOT_SET_ANYWHERE" })).rejects.toThrow(/not set on the server/);
    await expect(run({ password: "" })).rejects.toThrow(/not set/);
    expect(seen).toHaveLength(0);
  });

  it("ошибка API не раскрывает секрет, даже если сервер вернул его в теле", async () => {
    routes["POST /rest/api/2/search"] = [401, { errorMessages: [`bad credentials for ${TOKEN}`] }];
    const err = await run({ operation: "searchIssues", jql: "x = 1" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("редирект (например на страницу входа) — ошибка, на чужой адрес не ходим", async () => {
    routes["POST /rest/api/2/search"] = [302, undefined, { Location: "http://evil.example/login" }];
    await expect(run({ operation: "searchIssues", jql: "x = 1" })).rejects.toThrow(/unexpected redirect/);
  });

  it("проверки параметров: ключ задачи, пустые jql/комментарий, неизвестная операция", async () => {
    await expect(run({ operation: "getIssue", issueKey: "../etc" })).rejects.toThrow(/not an issue key/);
    await expect(run({ operation: "searchIssues", jql: " " })).rejects.toThrow(/jql/);
    await expect(run({ operation: "addComment", issueKey: "A-1", comment: "" })).rejects.toThrow(/comment/);
    await expect(run({ operation: "updateIssue", issueKey: "A-1" })).rejects.toThrow(/nothing to update/);
    await expect(run({ operation: "createIssue", project: "", summary: "x" })).rejects.toThrow(/required/);
    await expect(run({ operation: "nope" })).rejects.toThrow(/Unknown operation/);
    await expect(run({ username: "" })).rejects.toThrow(/username/);
    expect(seen).toHaveLength(0);
  });

  it("отмена запуска прерывает запрос", async () => {
    routes["POST /rest/api/2/search"] = [200, {}];
    const ac = new AbortController();
    ac.abort();
    await expect(run({ operation: "searchIssues", jql: "x = 1" }, undefined, ac.signal)).rejects.toThrow("Aborted");
  });
});

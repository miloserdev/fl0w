import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { readCapped, MAX_RESPONSE_BYTES } from "./http-request";
import { interpolate, isPlainObject, resolveTemplates } from "./json-path";
import { redact, resolveSecret } from "./secrets";
import { textOf } from "./value-io";

export const ATLASSIAN_OPERATIONS = ["searchIssues", "getIssue", "createIssue", "updateIssue", "addComment", "transitionIssue", "request"] as const;
export const ATLASSIAN_AUTH = ["form", "basic", "session", "bearer"] as const;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
/** Путь для произвольного запроса: только на тот же хост (начинается с одного «/»), без `..`, схемы и пробелов. */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;
const MAX_ERROR_BODY = 300;
const MAX_RESULTS = 100;

const when = (...ops: string[]) => ({ param: "operation", in: ops });
const ISSUE_OPS = ["getIssue", "updateIssue", "addComment", "transitionIssue"];

/** Atlassian ADF (формат текста Jira Cloud REST v3): абзацы из строк. */
function adf(text: string): Json {
  const paragraphs = text.split("\n").filter((l) => l.trim() !== "");
  return { type: "doc", version: 1, content: paragraphs.map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] })) };
}

/**
 * Atlassian (Jira): поиск по JQL, задача, создание/правка, комментарий, переход по статусам и произвольный REST-запрос
 * (последний покрывает и Confluence: `/rest/api/content`). Работает с Jira Server/Data Center и Cloud.
 *
 * Вход (`auth`): `form` — логин и пароль через форму входа Jira (`/login.jsp`, как в браузере; токен не нужен);
 * `basic` — логин и пароль заголовком Basic (или e-mail + API-токен в Cloud); `session` — вход через `/rest/auth/1/session`;
 * `bearer` — персональный токен (PAT, Server/DC 8.14+). Для `form` и `session` cookie живёт один вызов блока и в конце гасится.
 * Пароль/токен — текстом в параметре (он хранится во флоу) либо ссылкой на переменную окружения сервера `env:FL0W_SECRET_…`;
 * в логи, события и сообщения об ошибках он не попадает.
 * Адрес — свой `baseUrl`; запросы идут только на него (произвольный путь не может сменить хост), редиректы не выполняются.
 */
export class Atlassian extends Block {
  static type = "atlassian";
  static label = "Atlassian";
  static icon = "ticket";
  static category = "app";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    // например http://jira.dev.local или https://company.atlassian.net
    { name: "baseUrl", type: "string", required: true, expressions: false },
    { name: "auth", type: "enum", default: "form", options: ATLASSIAN_AUTH.map((value) => ({ value })) },
    { name: "username", type: "string", default: "", expressions: false, showWhen: { param: "auth", in: ["form", "basic", "session"] } },
    // пароль (или API-токен / PAT): прямо текстом либо ссылкой env:FL0W_SECRET_… на переменную окружения сервера
    { name: "password", type: "string", required: true, expressions: false },
    { name: "operation", type: "enum", default: "searchIssues", options: ATLASSIAN_OPERATIONS.map((value) => ({ value })) },
    { name: "apiVersion", type: "enum", default: "2", options: [{ value: "2" }, { value: "3" }] },
    { name: "jql", type: "string", multiline: true, default: "", showWhen: when("searchIssues") },
    { name: "maxResults", type: "number", default: 50, min: 1, max: MAX_RESULTS, showWhen: when("searchIssues") },
    // какие поля вернуть; пусто — по умолчанию Jira
    { name: "fields", type: "json", default: [], showWhen: when("searchIssues", "getIssue") },
    { name: "issueKey", type: "string", default: "", showWhen: when(...ISSUE_OPS) },
    { name: "project", type: "string", default: "", showWhen: when("createIssue") },
    { name: "issueType", type: "string", default: "Task", showWhen: when("createIssue") },
    { name: "summary", type: "string", default: "", showWhen: when("createIssue", "updateIssue") },
    { name: "description", type: "string", multiline: true, default: "", showWhen: when("createIssue", "updateIssue") },
    // дополнительные поля задачи { "labels": ["a"], "customfield_10000": … }
    { name: "extraFields", type: "json", default: {}, showWhen: when("createIssue", "updateIssue") },
    { name: "comment", type: "string", multiline: true, default: "", showWhen: when("addComment") },
    // id перехода или его имя («Done», «In Progress»)
    { name: "transition", type: "string", default: "", showWhen: when("transitionIssue") },
    { name: "method", type: "enum", default: "GET", options: [{ value: "GET" }, { value: "POST" }, { value: "PUT" }, { value: "DELETE" }], showWhen: when("request") },
    // путь от корня сайта: /rest/api/2/myself, /rest/api/content?spaceKey=DOC
    { name: "path", type: "string", default: "", showWhen: when("request") },
    { name: "body", type: "json", default: null, showWhen: when("request") },
    { name: "timeoutMs", type: "number", default: 30_000, min: 1000, max: 300_000 },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    const data = inputs["in0"] ?? null;
    const text = (name: string) => textOf(interpolate(typeof params[name] === "string" ? (params[name] as string) : "", data));

    const base = parseBase(params["baseUrl"]);
    const auth = String(params["auth"] ?? "basic");
    if (!(ATLASSIAN_AUTH as readonly string[]).includes(auth)) throw new Error(`Unknown auth "${auth}"`);
    const token = secretOf(params["password"]);
    const username = typeof params["username"] === "string" ? params["username"].trim() : "";
    if (auth !== "bearer" && username === "") throw new Error('Atlassian: "username" is required for this auth mode');
    const secrets = [token];
    const operation = String(params["operation"] ?? "searchIssues");
    const v = params["apiVersion"] === "3" ? "3" : "2";
    const timeoutMs = Math.min(Math.max(Math.trunc(Number(params["timeoutMs"] ?? 30_000)) || 30_000, 1000), 300_000);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    const richText = (s: string): Json => (v === "3" ? adf(s) : s);

    // запрос к Jira: один вход (cookie/заголовок) на вызов блока
    const headersBase: Record<string, string> = { Accept: "application/json", "X-Atlassian-Token": "no-check" };
    let cookie = "";
    const send = async (method: string, path: string, body?: Json, extra: Record<string, string> = {}): Promise<{ status: number; json: Json }> => {
      const headers: Record<string, string> = { ...headersBase, ...extra };
      if (auth === "basic") headers["Authorization"] = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
      else if (auth === "bearer") headers["Authorization"] = `Bearer ${token}`;
      else if (cookie) headers["Cookie"] = cookie; // form / session
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let res: Response;
      let raw: string;
      try {
        // редиректы не выполняем: перенаправление на страницу входа — это ошибка настройки, а не успех
        res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "manual" });
        raw = res.status >= 300 && res.status < 400 ? "" : await readCapped(res, MAX_RESPONSE_BYTES);
      } catch (e) {
        if (ctx.signal.aborted) throw new Error("Aborted", { cause: e });
        if (e instanceof Error && e.name === "TimeoutError") throw new Error(`Atlassian request timed out after ${timeoutMs} ms`, { cause: e });
        // причину не прикрепляем намеренно: исходная ошибка могла бы нести секрет, а в сообщении он вырезан (CLAUDE.md, «Секреты»)
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redact(`Atlassian request failed: ${e instanceof Error ? e.message : String(e)}`, secrets));
      }
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`Atlassian: unexpected redirect (HTTP ${res.status}) — check baseUrl and credentials`);
      }
      if (!res.ok) throw new Error(redact(`Atlassian HTTP ${res.status} ${res.statusText}: ${raw.slice(0, MAX_ERROR_BODY)}`, secrets).trim());
      if (raw.trim() === "") return { status: res.status, json: { ok: true } };
      try {
        return { status: res.status, json: JSON.parse(raw) as Json };
      } catch {
        throw new Error("Atlassian: response is not valid JSON");
      }
    };

    if (auth === "form") {
      // как форма входа Jira в браузере (os_username/os_password); успех — заголовок X-Seraph-LoginReason: OK и cookie сессии
      const form = new URLSearchParams({ os_username: username, os_password: token, os_destination: "", user_role: "", atl_token: "", login: "Log In" });
      let res: Response;
      try {
        res = await fetch(`${base}/login.jsp`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "X-Atlassian-Token": "no-check" },
          body: form,
          signal,
          redirect: "manual",
        });
        await res.arrayBuffer().catch(() => undefined); // тело страницы не нужно
      } catch (e) {
        if (ctx.signal.aborted) throw new Error("Aborted", { cause: e });
        if (e instanceof Error && e.name === "TimeoutError") throw new Error(`Atlassian login timed out after ${timeoutMs} ms`, { cause: e });
        // причину не прикрепляем намеренно (см. выше)
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redact(`Atlassian login failed: ${e instanceof Error ? e.message : String(e)}`, secrets));
      }
      const reason = res.headers.get("x-seraph-loginreason");
      if (reason && reason !== "OK") {
        throw new Error(`Atlassian: login failed (${reason}). Check the username and password; after several failed attempts Jira may require a CAPTCHA — sign in once in the browser`);
      }
      if (res.status >= 400) throw new Error(`Atlassian: login failed (HTTP ${res.status})`);
      const pairs = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0]!.trim())
        .filter((c) => /^[^=]+=.+$/.test(c));
      if (!pairs.some((c) => c.startsWith("JSESSIONID="))) throw new Error("Atlassian: login did not return a session (check the site URL and credentials)");
      for (const c of pairs) secrets.push(c.slice(c.indexOf("=") + 1));
      cookie = pairs.join("; ");
    }

    if (auth === "session") {
      const login = await send("POST", "/rest/auth/1/session", { username, password: token });
      const s = isPlainObject(login.json) ? login.json["session"] : null;
      if (!isPlainObject(s) || typeof s["name"] !== "string" || typeof s["value"] !== "string") throw new Error("Atlassian: login did not return a session");
      secrets.push(s["value"]);
      cookie = `${s["name"]}=${s["value"]}`;
    }

    try {
      const out = await this.operate(operation, { send, text, params, data, v, richText });
      return { out0: out };
    } finally {
      // сессия — одноразовая: гасим, чтобы не копились на сервере (ошибка выхода не важна)
      if (cookie) await send("DELETE", "/rest/auth/1/session").catch(() => undefined);
    }
  }

  private async operate(
    operation: string,
    c: {
      send: (m: string, p: string, b?: Json) => Promise<{ status: number; json: Json }>;
      text: (name: string) => string;
      params: Record<string, Json>;
      data: Json;
      v: string;
      richText: (s: string) => Json;
    },
  ): Promise<Json> {
    const { send, text, params, data, v, richText } = c;
    const api = `/rest/api/${v}`;
    const key = () => {
      const k = text("issueKey").trim();
      if (!ISSUE_KEY.test(k)) throw new Error(`Atlassian: "${k}" is not an issue key (expected PROJ-123)`);
      return encodeURIComponent(k);
    };
    const fieldList = (): string[] => {
      const f = params["fields"];
      if (f === undefined || f === null) return [];
      if (!Array.isArray(f) || f.some((x) => typeof x !== "string")) throw new Error('Atlassian: "fields" must be a list of field names');
      return f as string[];
    };
    const extra = (): Record<string, Json> => {
      const e = resolveTemplates(params["extraFields"] ?? {}, data);
      if (!isPlainObject(e)) throw new Error('Atlassian: "extraFields" must be an object');
      return e;
    };

    switch (operation) {
      case "searchIssues": {
        const jql = text("jql").trim();
        if (jql === "") throw new Error('Atlassian: "jql" is empty');
        const maxResults = Math.min(Math.max(Math.trunc(Number(params["maxResults"] ?? 50)) || 50, 1), MAX_RESULTS);
        const fields = fieldList();
        return (await send("POST", `${api}/search`, { jql, maxResults, ...(fields.length ? { fields } : {}) })).json;
      }
      case "getIssue": {
        const fields = fieldList();
        return (await send("GET", `${api}/issue/${key()}${fields.length ? `?fields=${fields.map(encodeURIComponent).join(",")}` : ""}`)).json;
      }
      case "createIssue": {
        const project = text("project").trim();
        const summary = text("summary");
        if (project === "" || summary.trim() === "") throw new Error('Atlassian: "project" and "summary" are required to create an issue');
        const description = text("description");
        const fields: Record<string, Json> = {
          ...extra(),
          project: { key: project },
          issuetype: { name: text("issueType").trim() || "Task" },
          summary,
          ...(description.trim() !== "" ? { description: richText(description) } : {}),
        };
        return (await send("POST", `${api}/issue`, { fields })).json;
      }
      case "updateIssue": {
        const summary = text("summary");
        const description = text("description");
        const fields: Record<string, Json> = {
          ...extra(),
          ...(summary.trim() !== "" ? { summary } : {}),
          ...(description.trim() !== "" ? { description: richText(description) } : {}),
        };
        if (Object.keys(fields).length === 0) throw new Error("Atlassian: nothing to update (set summary, description or extraFields)");
        const k = key();
        await send("PUT", `${api}/issue/${k}`, { fields });
        return { ok: true, key: decodeURIComponent(k) };
      }
      case "addComment": {
        const comment = text("comment");
        if (comment.trim() === "") throw new Error('Atlassian: "comment" is empty');
        return (await send("POST", `${api}/issue/${key()}/comment`, { body: richText(comment) })).json;
      }
      case "transitionIssue": {
        const wanted = text("transition").trim();
        if (wanted === "") throw new Error('Atlassian: "transition" is empty');
        const k = key();
        let id = /^\d+$/.test(wanted) ? wanted : "";
        if (id === "") {
          const list = (await send("GET", `${api}/issue/${k}/transitions`)).json;
          const items = isPlainObject(list) && Array.isArray(list["transitions"]) ? list["transitions"] : [];
          const hit = items.find((t) => isPlainObject(t) && typeof t["name"] === "string" && t["name"].toLowerCase() === wanted.toLowerCase());
          if (!isPlainObject(hit) || hit["id"] === undefined) {
            const names = items.flatMap((t) => (isPlainObject(t) && typeof t["name"] === "string" ? [t["name"]] : []));
            throw new Error(`Atlassian: no transition "${wanted}" for this issue (available: ${names.join(", ") || "none"})`);
          }
          id = String(hit["id"]);
        }
        await send("POST", `${api}/issue/${k}/transitions`, { transition: { id } });
        return { ok: true, key: decodeURIComponent(k), transition: id };
      }
      case "request": {
        const method = String(params["method"] ?? "GET");
        if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw new Error(`Unsupported method "${method}"`);
        const path = text("path").trim();
        if (!SAFE_PATH.test(path) || path.split("?")[0]!.split("/").some((s) => s === ".." || s === ".")) {
          throw new Error('Atlassian: "path" must start with a single "/" and contain no "..", scheme or spaces (e.g. /rest/api/2/myself)');
        }
        const body = method === "GET" || method === "DELETE" ? undefined : resolveTemplates(params["body"] ?? data, data);
        return (await send(method, path, body)).json;
      }
      default:
        throw new Error(`Unknown operation "${operation}"`);
    }
  }
}

/** Адрес сайта без пути и учётных данных в нём: запросы идут только на него. */
function parseBase(raw: Json | undefined): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Atlassian: "baseUrl" is not a valid URL (e.g. http://jira.dev.local)');
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error('Atlassian: "baseUrl" must be http(s)');
  if (u.username || u.password) throw new Error('Atlassian: "baseUrl" must not contain credentials — use username and a secret password');
  if (u.search || u.hash) throw new Error('Atlassian: "baseUrl" must not contain a query or fragment');
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** Пароль/токен: текст как есть либо `env:FL0W_SECRET_…` (читается из окружения сервера). */
function secretOf(raw: Json | undefined): string {
  return resolveSecret(typeof raw === "string" ? raw.trim() : "", undefined);
}

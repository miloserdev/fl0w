import type { Json } from "@fl0w/schema";
import { redact } from "./secrets";

/** Bot API address; the variable is needed for a self-hosted Bot API server and for tests (real Telegram is not called in tests). */
export const TELEGRAM_API_ENV = "FL0W_TELEGRAM_API";
const DEFAULT_API = "https://api.telegram.org";
/** BotFather token format: `123456789:AA...`. The token goes into the URL path, so only the strict format is accepted; otherwise the path could be spoofed. */
const TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // getFile limit in the Bot API

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export function assertToken(token: string): void {
  if (!TOKEN_RE.test(token)) throw new Error("Telegram bot token has an invalid format (expected 123456:ABC… from @BotFather)");
}

export function apiBase(): string {
  const raw = process.env[TELEGRAM_API_ENV] ?? DEFAULT_API;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${TELEGRAM_API_ENV} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${TELEGRAM_API_ENV} must be an http(s) URL`);
  return raw.replace(/\/+$/, "");
}

export type TelegramUpload = { field: string; fileName: string; bytes: Uint8Array };
export type CallOptions = { signal?: AbortSignal; timeoutMs?: number; uploads?: TelegramUpload[] };

function signalFor(opts: CallOptions, fallbackMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? fallbackMs);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** Call a Bot API method. Returns `result`; an API error is a `TelegramError` with a description; the token is hidden in messages. */
export async function callTelegram(
  token: string,
  method: string,
  params: Record<string, Json | undefined>,
  opts: CallOptions = {},
): Promise<Json> {
  assertToken(token);
  if (!/^[A-Za-z]+$/.test(method)) throw new Error(`Invalid Telegram method "${method}"`);
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  const uploads = opts.uploads ?? [];

  let init: RequestInit;
  if (uploads.length > 0) {
    // multipart: non-file parameters are strings, objects are a JSON string (a Bot API rule)
    const form = new FormData();
    for (const [k, v] of clean) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    for (const u of uploads) form.append(u.field, new Blob([u.bytes as BlobPart]), u.fileName);
    init = { method: "POST", body: form };
  } else {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(clean)) };
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${apiBase()}/bot${token}/${method}`, { ...init, signal: signalFor(opts, uploads.length ? 120_000 : 60_000) });
    text = await res.text();
  } catch (e) {
    if (opts.signal?.aborted) throw new Error("Aborted", { cause: e });
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError") throw new Error("Telegram request timed out", { cause: e });
    // put an already sanitised copy into the cause: the original error could contain a URL with the token
    const safe = redact(e instanceof Error ? e.message : String(e), [token]);
    // eslint-disable-next-line preserve-caught-error -- the cause is sanitised deliberately: the original could contain a URL with the token
    throw new Error(`Telegram request failed: ${safe}`, { cause: new Error(safe) });
  }

  let body: { ok?: boolean; result?: Json; description?: string; error_code?: number; parameters?: { retry_after?: number } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new TelegramError(`Telegram returned HTTP ${res.status} (not JSON)`, res.status);
  }
  if (!body.ok) {
    const retry = body.parameters?.retry_after;
    const desc = redact(body.description ?? `HTTP ${res.status}`, [token]);
    throw new TelegramError(`Telegram error ${body.error_code ?? res.status}: ${desc}${retry ? ` (retry after ${retry} s)` : ""}`, body.error_code, retry);
  }
  return body.result ?? null;
}

/** Downloads a file by `file_path` from getFile (up to 20 MB). */
export async function downloadTelegramFile(token: string, filePath: string, opts: CallOptions = {}): Promise<Uint8Array> {
  assertToken(token);
  if (!/^[A-Za-z0-9_\-./]+$/.test(filePath) || filePath.split("/").includes("..")) throw new Error("Telegram returned an unsafe file path");
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/file/bot${token}/${filePath}`, { signal: signalFor(opts, 120_000) });
  } catch (e) {
    if (opts.signal?.aborted) throw new Error("Aborted", { cause: e });
    const safe = redact(e instanceof Error ? e.message : String(e), [token]);
    // eslint-disable-next-line preserve-caught-error -- the cause is sanitised deliberately: the original could contain a URL with the token
    throw new Error(`Telegram download failed: ${safe}`, { cause: new Error(safe) });
  }
  if (!res.ok) throw new TelegramError(`Telegram file download failed: HTTP ${res.status}`, res.status);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("Telegram file is larger than 20 MB");
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("Telegram file is larger than 20 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

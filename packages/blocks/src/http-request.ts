import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";

const MAX_ERROR_BODY = 200;

export class HttpRequest extends Block {
  static type = "http_request";
  static label = "HTTP Request";
  static icon = "world-www";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    {
      name: "method",
      type: "enum",
      required: true,
      default: "GET",
      options: [{ value: "GET" }, { value: "POST" }],
    },
    { name: "url", type: "string", required: true },
    { name: "headers", type: "json", default: {} },
    // POST body; if null, the in0 input is sent (when it is connected)
    { name: "body", type: "json", default: null },
    { name: "timeoutMs", type: "number", default: 15000 },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    const method = String(params["method"] ?? "GET");
    const url = new URL(String(params["url"]));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported protocol "${url.protocol}"`);
    }

    const headers: Record<string, string> = {};
    const rawHeaders = params["headers"];
    if (rawHeaders !== null && rawHeaders !== undefined) {
      if (typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
        throw new Error('Parameter "headers" must be an object');
      }
      for (const [k, v] of Object.entries(rawHeaders)) headers[k] = String(v);
    }

    let body: string | undefined;
    if (method === "POST") {
      const payload = params["body"] ?? inputs["in0"];
      if (payload !== undefined && payload !== null) {
        body = JSON.stringify(payload);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const timeoutMs = Number(params["timeoutMs"] ?? 15000);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, { method, headers, body, signal });
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      if (ctx.signal.aborted) throw new Error("Aborted", { cause: e });
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new Error(`Request timed out after ${timeoutMs} ms`, { cause: e });
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, MAX_ERROR_BODY)}`.trim());
    }
    if (text.trim() === "") return { out0: null };
    try {
      return { out0: JSON.parse(text) as Json };
    } catch {
      throw new Error("Response is not valid JSON");
    }
  }
}/** Response body size limit: above it is an error, not process memory (`Content-Length` is checked at once, the stream is cut off as it is read). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error(`Response is larger than ${limit} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Response is larger than ${limit} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}



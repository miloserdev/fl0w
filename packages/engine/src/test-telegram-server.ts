import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "@fl0w/schema";

export const TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
export const TOKEN2 = "777777:ZZZ-DEF1234ghIkl-zyx57W2v1u123ew11";

export type Call = { token: string; method: string; params: Record<string, Json> };
type Update = Record<string, Json> & { update_id: number };

/**
 * Fake Bot API: honest getUpdates semantics, updates with update_id < offset count as acknowledged and are
 * deleted; while there are no updates, the request "hangs" for up to `timeout` seconds (no more than `maxWaitMs`) or until new ones arrive.
 */
export class FakeTelegram {
  server!: Server;
  url = "";
  calls: Call[] = [];
  /** Unacknowledged updates per token. */
  queues = new Map<string, Update[]>();
  /** How many getUpdates hang at once per token (for checking "one poll per bot"). */
  inflight = new Map<string, number>();
  maxInflight = new Map<string, number>();
  /** Response override: return { status, body } instead of the normal handling. */
  override?: (call: Call) => { status: number; body: unknown } | undefined;
  maxWaitMs = 300;
  readonly defaultMaxWaitMs = 300;
  private waiters: (() => void)[] = [];
  private nextId = 1;

  async start(port = 0) {
    this.server = createServer(async (req, res) => {
      const call = await this.parse(req);
      if (!call) return void res.writeHead(404).end();
      this.calls.push(call);
      const o = this.override?.(call);
      if (o) return void res.writeHead(o.status, { "content-type": "application/json" }).end(JSON.stringify(o.body));
      if (call.method === "getUpdates") return void (await this.getUpdates(call, req, res));
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, result: { message_id: 100 + this.calls.length, chat: { id: call.params["chat_id"] ?? null }, text: call.params["text"] ?? null } }),
      );
    });
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }

  /** A new update for the bot; returns its update_id. */
  push(token: string, body: Record<string, Json>): number {
    const u = { update_id: this.nextId++, ...body } as Update;
    this.queues.set(token, [...(this.queues.get(token) ?? []), u]);
    for (const w of this.waiters.splice(0)) w();
    return u.update_id;
  }

  calls_(method: string, token = TOKEN) {
    return this.calls.filter((c) => c.method === method && c.token === token);
  }

  private async parse(req: IncomingMessage): Promise<Call | null> {
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
    if (!m) return null;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return { token: m[1]!, method: m[2]!, params: text ? (JSON.parse(text) as Record<string, Json>) : {} };
  }

  private async getUpdates(call: Call, req: IncomingMessage, res: import("node:http").ServerResponse) {
    const { token } = call;
    const offset = typeof call.params["offset"] === "number" ? call.params["offset"] : undefined;
    let q = this.queues.get(token) ?? [];
    if (offset !== undefined && offset >= 0) q = q.filter((u) => u.update_id >= offset);
    else if (offset !== undefined && offset < 0) q = q.slice(-1); // offset=-1: only the last one
    this.queues.set(token, offset !== undefined && offset >= 0 ? q : (this.queues.get(token) ?? []));

    const cur = (this.inflight.get(token) ?? 0) + 1;
    this.inflight.set(token, cur);
    this.maxInflight.set(token, Math.max(this.maxInflight.get(token) ?? 0, cur));
    let closed = false;
    req.on("close", () => (closed = true));
    try {
      const timeoutMs = Math.min(Number(call.params["timeout"] ?? 0) * 1000, this.maxWaitMs);
      if (q.length === 0 && timeoutMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, timeoutMs);
          const wake = () => (clearTimeout(t), resolve());
          this.waiters.push(wake);
          req.on("close", wake); // the client aborted the request, a real server also stops serving it
        });
        const fresh = (this.queues.get(token) ?? []).filter((u) => offset === undefined || offset < 0 || u.update_id >= offset);
        q = offset !== undefined && offset < 0 ? fresh.slice(-1) : fresh;
      }
      if (!closed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: q }));
    } finally {
      this.inflight.set(token, (this.inflight.get(token) ?? 1) - 1);
    }
  }
}

export const msg = (chatId: number, text: string, extra: Record<string, Json> = {}): Record<string, Json> => ({
  message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: "U" }, text, ...extra },
});

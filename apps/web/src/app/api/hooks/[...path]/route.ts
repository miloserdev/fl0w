import { normalizeWebhookPath, registry } from "@fl0w/blocks";
import { SchedulerBusyError } from "@fl0w/engine/server";
import type { Flow, Json, RunnerEvent } from "@fl0w/schema";
import { PayloadTooLarge, readBody } from "@/server/read-body";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

function parseBody(text: string, contentType: string): Json {
  if (text === "") return null;
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as Json;
    } catch {
      return text; // битый JSON отдаём как есть — флоу сам решит, что с ним делать
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

/** Ответ из событий запуска: Respond to Webhook, иначе результат Result, иначе ошибка. */
function responseFrom(flow: Flow, events: RunnerEvent[]): Response {
  const responders = new Set(flow.nodes.filter((n) => n.type === "respond_to_webhook").map((n) => n.id));
  for (const e of events) {
    if (e.event !== "node:done" || !responders.has(e.nodeId)) continue;
    const r = e.output["response"] as { status: number; headers: Record<string, string>; body: Json } | undefined;
    if (!r) continue;
    const headers = new Headers(r.headers);
    if (typeof r.body === "string") {
      if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
      return new Response(r.body, { status: r.status, headers });
    }
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(r.body), { status: r.status, headers });
  }
  const done = events.find((e) => e.event === "flow:done");
  if (done?.event === "flow:done") {
    if (done.error !== undefined) return Response.json({ error: done.error }, { status: 500 });
    if (done.result !== undefined) return Response.json(done.result);
  }
  return Response.json({ message: "Workflow finished" });
}

async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  const rt = getRuntime();
  await rt.start();

  const hookPath = path.map(decodeURIComponent).join("/");
  const hook = rt.scheduler.findWebhook(req.method, hookPath);
  if (!hook) {
    // Вебхук регистрируется только у ОПУБЛИКОВАННОГО флоу. Если такой путь есть у сохранённого черновика — говорим об этом прямо.
    const normalized = normalizeWebhookPath(hookPath);
    const drafts = (await rt.store.list()).filter(
      (f) => f.status !== "published" && f.nodes.some((n) => registry[n.type]?.webhook(n.params)?.path === normalized),
    );
    return Response.json(
      {
        error: "No webhook is registered for this path",
        ...(drafts.length > 0
          ? { hint: `A Webhook with this path exists in ${drafts.map((f) => `"${f.name}" (${f.id})`).join(", ")}, but the flow is not published — publish it (the editor's Run does not register webhooks)` }
          : {}),
      },
      { status: 404 },
    );
  }

  let body: Json = null;
  try {
    body = parseBody(await readBody(req), req.headers.get("content-type") ?? "");
  } catch (e) {
    if (e instanceof PayloadTooLarge) return Response.json({ error: "Payload too large" }, { status: 413 });
    throw e;
  }

  const query: Record<string, Json> = {};
  for (const [k, v] of new URL(req.url).searchParams) {
    const prev = query[k];
    query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const headers: Record<string, Json> = {};
  req.headers.forEach((v, k) => {
    if (k !== "cookie") headers[k] = v;
  });
  const payload: Json = { method: req.method, path: path.join("/"), query, headers, body };

  const node = hook.flow.nodes.find((n) => n.id === hook.nodeId);
  const waitForFinish = node?.params["respond"] === "whenFinished" && registry[node.type] !== undefined;
  try {
    if (!waitForFinish) {
      // отвечаем сразу, флоу идёт в фоне; итог запуска виден в Watch и логе планировщика
      void rt.scheduler.trigger(hook.flow.id, hook.nodeId, payload);
      return Response.json({ message: "Workflow was started" });
    }
    const events: RunnerEvent[] = [];
    await rt.scheduler.trigger(hook.flow.id, hook.nodeId, payload, (e) => void events.push(e));
    return responseFrom(hook.flow, events);
  } catch (e) {
    if (e instanceof SchedulerBusyError) return Response.json({ error: e.message }, { status: 429 });
    throw e;
  }
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };

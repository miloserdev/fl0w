import { PayloadTooLarge, readBody } from "@/server/read-body";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

/** Вебхук Telegram: сюда Bot API присылает обновления (режим webhook у Telegram Trigger). */
export async function POST(req: Request, { params }: Ctx) {
  const { key } = await params;
  const rt = getRuntime();
  await rt.start();
  let update: unknown;
  try {
    update = JSON.parse(await readBody(req));
  } catch (e) {
    return new Response(null, { status: e instanceof PayloadTooLarge ? 413 : 400 });
  }
  const result = rt.telegram.handleWebhook(key, req.headers.get("x-telegram-bot-api-secret-token"), update);
  return new Response(null, { status: result === "ok" ? 200 : result === "unauthorized" ? 401 : 404 });
}

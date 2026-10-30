import { registry } from "@fl0w/blocks";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/flows — серверные флоу для выбора цели блока Run Flow: id, имя, статус и триггеры (id и тип).
 * Вызвать можно только опубликованные флоу, но список отдаёт все, чтобы редактор мог подсказать «сначала опубликуйте».
 */
export async function GET() {
  const rt = getRuntime();
  await rt.start();
  const flows = await rt.store.list();
  return Response.json({
    flows: flows.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status ?? "draft",
      triggers: f.nodes.filter((n) => registry[n.type]?.isTrigger).map((n) => ({ id: n.id, type: n.type })),
    })),
  });
}

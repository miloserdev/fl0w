import { registry } from "@fl0w/blocks";
import { channelsOf } from "@fl0w/engine";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/flows — серверные флоу: id, имя, статус, триггеры и каналы phone-пар (для подсказок в блоках phone-outgoing/incoming).
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
      // каналы phone-пар этого флоу: подсказки для выбора канала в блоках phone-outgoing / phone-incoming
      channels: { incoming: channelsOf(f).incoming.map((e) => e.channelId), outgoing: channelsOf(f).outgoing.map((e) => e.channelId) },
    })),
  });
}

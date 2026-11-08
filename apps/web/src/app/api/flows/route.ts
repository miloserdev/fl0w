import { registry } from "@fl0w/blocks";
import { channelsOf } from "@fl0w/engine";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/flows — server flows: id, name, status, triggers and call-pair channels (for hints in the outgoing call/incoming blocks).
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
      // call-pair channels of this flow: hints for picking a channel in the outgoing call / incoming call blocks
      channels: { incoming: channelsOf(f).incoming.map((e) => e.channelId), outgoing: channelsOf(f).outgoing.map((e) => e.channelId) },
    })),
  });
}

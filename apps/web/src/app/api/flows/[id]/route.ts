import { registry } from "@fl0w/blocks";
import { formatIssues, validateCallChannels, validateFlow } from "@fl0w/engine";
import { isSafeFlowId } from "@fl0w/engine/server";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/flows/:id — the server copy of the flow (draft/published status) and a summary of the last run. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const rt = getRuntime();
  await rt.start();
  const flow = await rt.store.get(id);
  if (!flow) return Response.json({ error: "Flow not found" }, { status: 404 });
  return Response.json({
    flow,
    scheduled: rt.scheduler.isScheduled(id),
    lastRun: rt.hub.lastRun(id) ?? null,
  });
}

/**
 * PUT /api/flows/:id  { flow }
 * Saves the server copy. `flow.status: "published"` turns on the trigger schedule,
 * "draft" turns it off. 400 for an invalid flow or for publishing without a trigger.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isSafeFlowId(id)) return Response.json({ error: "Invalid flow id" }, { status: 400 });

  const body: unknown = await req.json().catch(() => null);
  const checked = validateFlow((body as { flow?: unknown } | null)?.flow, registry);
  if (!checked.ok) {
    return Response.json(
      { error: `Invalid flow: ${formatIssues(checked.issues)}`, issues: checked.issues },
      { status: 400 },
    );
  }
  const flow = checked.flow;
  if (flow.id !== id) {
    return Response.json({ error: "Flow id does not match the URL" }, { status: 400 });
  }
  if (flow.status === "published" && !flow.nodes.some((n) => !n.disabled && registry[n.type]?.autoTrigger)) {
    return Response.json(
      { error: "Publishing requires an automatic trigger block (Every or Webhook)", code: "no_trigger" },
      { status: 400 },
    );
  }

  const rt = getRuntime();
  await rt.start();
  // call pair: a channel links exactly one incoming and one outgoing phone, including among the other saved flows
  const clashes = validateCallChannels(flow, await rt.store.list());
  if (clashes.length > 0) {
    return Response.json(
      { error: clashes.map((c) => c.message).join("; "), code: "call_channel", issues: clashes },
      { status: 400 },
    );
  }
  if (flow.status === "published") {
    const problems = rt.scheduler.problems(flow);
    if (problems.length > 0) {
      return Response.json({ error: problems.join("; "), code: "bad_trigger", problems }, { status: 409 });
    }
  }
  // reason for lifecycle triggers: first publication or an update of an already published flow
  const previous = await rt.store.get(id);
  await rt.store.put(flow);
  rt.scheduler.sync(flow, flow.status === "published" ? (previous?.status === "published" ? "update" : "publish") : undefined);
  return Response.json({ flow, scheduled: rt.scheduler.isScheduled(id) });
}

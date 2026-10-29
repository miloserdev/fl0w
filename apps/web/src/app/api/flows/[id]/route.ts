import { registry } from "@fl0w/blocks";
import { formatIssues, validateFlow } from "@fl0w/engine";
import { isSafeFlowId } from "@fl0w/engine/server";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/flows/:id — серверная копия флоу (статус draft/published) и сводка последнего запуска. */
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
 * Сохраняет серверную копию. `flow.status: "published"` включает расписание триггеров,
 * "draft" — выключает. 400 при невалидном флоу или публикации без триггера.
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
  if (flow.status === "published" && !flow.nodes.some((n) => registry[n.type]?.autoTrigger)) {
    return Response.json(
      { error: "Publishing requires an automatic trigger block (Every or Webhook)", code: "no_trigger" },
      { status: 400 },
    );
  }

  const rt = getRuntime();
  await rt.start();
  if (flow.status === "published") {
    const problems = rt.scheduler.problems(flow);
    if (problems.length > 0) {
      return Response.json({ error: problems.join("; "), code: "bad_trigger", problems }, { status: 409 });
    }
  }
  // повод для триггеров жизненного цикла: первая публикация или обновление уже опубликованного флоу
  const previous = await rt.store.get(id);
  await rt.store.put(flow);
  rt.scheduler.sync(flow, flow.status === "published" ? (previous?.status === "published" ? "update" : "publish") : undefined);
  return Response.json({ flow, scheduled: rt.scheduler.isScheduled(id) });
}

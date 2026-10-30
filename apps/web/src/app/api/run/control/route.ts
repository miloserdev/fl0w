import { isRunId, runControls } from "@/server/run-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/run/control { runId, action: "pause" | "resume" } — пауза идущего пробного запуска. Остановка — обрыв соединения /api/run. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { runId?: unknown; action?: unknown } | null;
  if (!isRunId(body?.runId) || (body?.action !== "pause" && body?.action !== "resume")) {
    return Response.json({ error: "Invalid runId/action" }, { status: 400 });
  }
  const control = runControls.get(body.runId);
  if (!control) return Response.json({ error: "No such running run" }, { status: 404 });
  if (body.action === "pause") control.pause();
  else control.resume();
  return Response.json({ ok: true });
}

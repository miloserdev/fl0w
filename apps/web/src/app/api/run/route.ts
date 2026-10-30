import { registry } from "@fl0w/blocks";
import { formatIssues, validateFlow } from "@fl0w/engine";
import { runFlowInProcess } from "@fl0w/engine/process";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { engineDir } from "@/server/engine-dir";
import { getRuntime, RUN_TIMEOUT_MS } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/run  { flow, from?, seeds? } — from/seeds: перезапуск с ноды (данные предшественников из прошлого запуска)
 * 400 { error, issues }  — флоу не прошёл валидацию (до запуска процесса).
 * 200 application/x-ndjson — по строке JSON на событие `RunnerEvent`; последняя — `flow:done`.
 * Разрыв соединения клиентом убивает процесс-раннер.
 */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  const checked = validateFlow((body as { flow?: unknown } | null)?.flow, registry);
  if (!checked.ok) {
    return Response.json(
      { error: `Invalid flow: ${formatIssues(checked.issues)}`, issues: checked.issues },
      { status: 400 },
    );
  }

  const { from, seeds } = (body ?? {}) as { from?: unknown; seeds?: unknown };
  const seedsOk =
    seeds === undefined ||
    (typeof seeds === "object" && seeds !== null && !Array.isArray(seeds) && Object.values(seeds).every((v) => typeof v === "object" && v !== null && !Array.isArray(v)));
  if ((from !== undefined && typeof from !== "string") || !seedsOk) {
    return Response.json({ error: "Invalid from/seeds" }, { status: 400 });
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (e: RunnerEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          // клиент уже ушёл — поток закрыт
        }
      };
      runFlowInProcess(checked.flow, emit, {
        engineDir: engineDir(),
        signal: abort.signal,
        timeoutMs: RUN_TIMEOUT_MS,
        // блок Run Flow в ручном запуске вызывает настоящие опубликованные флоу; цепочка начинается с этого флоу
        // Вызов триггера ЭТОГО ЖЕ флоу (локального, возможно неопубликованного) идёт без публикации, его события попадают в ленту
        // запуска (кроме flow:done — итог один, внешний). Другие флоу вызываются как опубликованные.
        onFire: (req) =>
          getRuntime().scheduler.fireFrom([checked.flow.id], req, {
            flow: checked.flow,
            onEvent: (e) => {
              if (e.event !== "flow:done") emit(e);
            },
          }),
        from: from as string | undefined,
        seeds: seeds as Record<string, Record<string, Json>> | undefined,
        onStderr: (chunk) => process.stderr.write(chunk),
      }).finally(() => {
        try {
          controller.close();
        } catch {
          // уже закрыт
        }
      });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

import { registry } from "@fl0w/blocks";
import { findIncoming, formatIssues, validateFlow } from "@fl0w/engine";
import { runFlowInProcess } from "@fl0w/engine/process";
import { flowSchema, type Flow, type Json, type RunnerEvent } from "@fl0w/schema";
import { engineDir } from "@/server/engine-dir";
import { getRuntime, RUN_TIMEOUT_MS } from "@/server/runtime";
import { isRunId, runControls } from "@/server/run-controls";

/** Сколько флоу других вкладок учитываем при вызовах. */
const MAX_OTHER_FLOWS = 20;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/run  { flow, from?, seeds? } — from/seeds: перезапуск с ноды (данные предшественников из прошлого запуска)
 * runId?: идентификатор для паузы через POST /api/run/control.
 * others?: флоу остальных вкладок редактора (до 20): среди них Emitter ищет Collector раньше сохранённых копий.
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

  const { from, seeds, trigger, runId, others } = (body ?? {}) as { from?: unknown; seeds?: unknown; trigger?: unknown; runId?: unknown; others?: unknown };
  // чужие вкладки — только кандидаты для вызова: невалидные по схеме пропускаем, число ограничиваем
  const otherFlows: Flow[] = Array.isArray(others)
    ? others.slice(0, MAX_OTHER_FLOWS).flatMap((f) => {
        const p = flowSchema.safeParse(f);
        return p.success ? [p.data] : [];
      })
    : [];
  const seedsOk =
    seeds === undefined ||
    (typeof seeds === "object" && seeds !== null && !Array.isArray(seeds) && Object.values(seeds).every((v) => typeof v === "object" && v !== null && !Array.isArray(v)));
  if ((from !== undefined && typeof from !== "string") || (trigger !== undefined && typeof trigger !== "string") || !seedsOk || (runId !== undefined && !isRunId(runId))) {
    return Response.json({ error: "Invalid from/seeds/trigger" }, { status: 400 });
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
        // «Запустить» — песочница: отдельная память, вызовы других флоу не затрагивают рабочие (опубликованные) копии
        sandbox: true,
        // outgoing call в песочнице находит incoming call среди СОХРАНЁННЫХ копий (публикация не нужна); этот флоу — по версии
        // из редактора, а не сохранённой. Рабочие (опубликованные) запуски не затрагиваются.
        onResolveCall: async (channelId) => {
          const saved = await getRuntime().store.list();
          const open = otherFlows.filter((f) => f.id !== checked.flow.id);
          const taken = new Set([checked.flow.id, ...open.map((f) => f.id)]);
          return findIncoming([checked.flow, ...open, ...saved.filter((f) => !taken.has(f.id))], channelId);
        },
        // кнопка «запустить» на ноде Manual: стартует только этот триггер, закрепления песочницы при этом действуют
        trigger: trigger as string | undefined,
        pins: true,
        onControl: (c) => {
          if (typeof runId === "string") runControls.set(runId, c);
        },
        from: from as string | undefined,
        seeds: seeds as Record<string, Record<string, Json>> | undefined,
        onStderr: (chunk) => process.stderr.write(chunk),
      }).finally(() => {
        if (typeof runId === "string") runControls.delete(runId);
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

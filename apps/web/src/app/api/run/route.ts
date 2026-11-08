import { registry } from "@fl0w/blocks";
import { findIncoming, formatIssues, validateFlow } from "@fl0w/engine";
import { runFlowInProcess } from "@fl0w/engine/process";
import { flowSchema, type Flow, type Json, type RunnerEvent } from "@fl0w/schema";
import { engineDir } from "@/server/engine-dir";
import { getRuntime, RUN_TIMEOUT_MS } from "@/server/runtime";
import { isRunId, runControls } from "@/server/run-controls";

/** How many flows from other tabs are taken into account for calls. */
const MAX_OTHER_FLOWS = 20;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/run  { flow, from?, seeds? } — from/seeds: restart from a node (predecessors' data from the previous run)
 * runId?: identifier for pausing via POST /api/run/control.
 * others?: flows of the other editor tabs (up to 20): Emitter looks for a Collector among them before the saved copies.
 * 400 { error, issues }  — the flow failed validation (before the process starts).
 * 200 application/x-ndjson — one JSON line per `RunnerEvent`; the last one is `flow:done`.
 * If the client drops the connection, the runner process is killed.
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
  // other tabs are only call candidates: those invalid against the schema are skipped, the count is capped
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
          // the client is gone — the stream is closed
        }
      };
      runFlowInProcess(checked.flow, emit, {
        engineDir: engineDir(),
        signal: abort.signal,
        timeoutMs: RUN_TIMEOUT_MS,
        // "Run" is a sandbox: separate memory, calls to other flows do not touch the working (published) copies
        sandbox: true,
        // in the sandbox, outgoing call finds incoming call among the SAVED copies (no publishing needed); this flow is taken as
        // edited in the editor, not as saved. Working (published) runs are not affected.
        onResolveCall: async (channelId) => {
          const saved = await getRuntime().store.list();
          const open = otherFlows.filter((f) => f.id !== checked.flow.id);
          const taken = new Set([checked.flow.id, ...open.map((f) => f.id)]);
          return findIncoming([checked.flow, ...open, ...saved.filter((f) => !taken.has(f.id))], channelId);
        },
        // the "run" button on a Manual node: starts only this trigger, sandbox pins still apply
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
          // already closed
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

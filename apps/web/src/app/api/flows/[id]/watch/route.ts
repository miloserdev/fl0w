import { isSafeFlowId } from "@fl0w/engine/server";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/flows/:id/watch — live feed of the flow's runs, NDJSON (`WatchMessage`).
 * The last run is replayed first, then new events follow. An empty line is a heartbeat.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeFlowId(id)) return Response.json({ error: "Invalid flow id" }, { status: 400 });

  const rt = getRuntime();
  await rt.start();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup(); // the stream is already closed by the client
        }
      };
      const unsubscribe = rt.hub.subscribe(id, (m) => write(`${JSON.stringify(m)}\n`));
      const heartbeat = setInterval(() => write("\n"), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

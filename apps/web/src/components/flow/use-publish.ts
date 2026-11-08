"use client";

import { isLayoutBlock } from "@/lib/layout";
import type { Flow, FlowStatus } from "@fl0w/schema";
import { useCallback, useEffect, useState } from "react";
import { flowFingerprint } from "@/lib/flow-convert";

/** Server copy of the flow: exactly what is published and runs on schedule. */
export type ServerFlow = {
  /** The whole server copy: unpublishing sends it, not the local (possibly invalid) edits. */
  flow: Flow;
  id: string;
  status: FlowStatus;
  fingerprint: string;
  nodeIds: string[];
};

type ApiFlow = { flow: Flow };

const toServerFlow = (flow: Flow): ServerFlow => ({
  flow,
  id: flow.id,
  status: flow.status ?? "draft",
  fingerprint: flowFingerprint(flow),
  nodeIds: flow.nodes.filter((n) => !isLayoutBlock(n.type)).map((n) => n.id),
});

/** Publishing a flow on the server: turns the schedule of its triggers on/off. */
export function usePublish(flowId: string) {
  const [loaded, setLoaded] = useState<ServerFlow | null>(null);
  const [busy, setBusy] = useState(false);
  // the state is bound to the id: after the flow changes, someone else's copy is not shown
  const server = loaded?.id === flowId ? loaded : null;

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/flows/${flowId}`, { signal: ac.signal });
        if (res.ok) setLoaded(toServerFlow(((await res.json()) as ApiFlow).flow));
      } catch {
        // the server is unavailable or the request was cancelled — stay without a server copy
      }
    })();
    return () => ac.abort();
  }, [flowId]);

  /** Saves the flow on the server with the required status. Returns the error text or null. */
  const save = useCallback(
    async (flow: Flow, status: FlowStatus): Promise<string | null> => {
      setBusy(true);
      try {
        const res = await fetch(`/api/flows/${flow.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flow: { ...flow, status } }),
        });
        const body = (await res.json().catch(() => null)) as (ApiFlow & { error?: string }) | null;
        if (!res.ok || !body?.flow) return body?.error ?? `HTTP ${res.status}`;
        setLoaded(toServerFlow(body.flow));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { server, busy, save };
}

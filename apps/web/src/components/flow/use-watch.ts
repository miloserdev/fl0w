"use client";

import { watchMessageSchema } from "@fl0w/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { beginWatchRun, IDLE_RUN, reduceRun, type RunState } from "./use-run";

const RECONNECT_MS = 2000;

/**
 * Live feed of a published flow's runs: subscription to /api/flows/:id/watch.
 * The server first replays the last run, then sends new ones; reconnects on disconnect.
 */
export function useWatch(flowId: string, enabled: boolean, nodeIds: string[]) {
  const [state, setState] = useState<RunState>(IDLE_RUN);
  const [connected, setConnected] = useState(false);
  // the reducer in a long-lived stream needs the current node list; the ref is updated outside of render
  const idsRef = useRef(nodeIds);
  useEffect(() => {
    idsRef.current = nodeIds;
  }, [nodeIds]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();

    (async () => {
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(`/api/flows/${flowId}/watch`, { signal: ac.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          setConnected(true);

          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue; // heartbeat
              const parsed = watchMessageSchema.safeParse(JSON.parse(line));
              if (!parsed.success) continue;
              const m = parsed.data;
              if (m.type === "run:start") setState((s) => beginWatchRun(s, m.nodes));
              else if (m.type === "run:event") setState((s) => reduceRun(s, m.event, idsRef.current));
            }
          }
        } catch {
          // disconnect or stop — decided by the check below
        }
        setConnected(false);
        if (ac.signal.aborted) return;
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    })();

    return () => {
      ac.abort();
      setConnected(false);
    };
  }, [flowId, enabled]);

  const reset = useCallback(() => setState(IDLE_RUN), []);
  return { state, connected: enabled && connected, reset };
}

"use client";

import type { Flow, FlowStatus } from "@fl0w/schema";
import { useCallback, useEffect, useState } from "react";
import { flowFingerprint } from "@/lib/flow-convert";

/** Серверная копия флоу: что именно опубликовано и исполняется по расписанию. */
export type ServerFlow = {
  /** Серверная копия целиком: снятие с публикации отправляет её, а не локальные (возможно невалидные) правки. */
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
  nodeIds: flow.nodes.map((n) => n.id),
});

/** Публикация флоу на сервере: включает/выключает расписание его триггеров. */
export function usePublish(flowId: string) {
  const [loaded, setLoaded] = useState<ServerFlow | null>(null);
  const [busy, setBusy] = useState(false);
  // состояние привязано к id: после смены флоу чужая копия не показывается
  const server = loaded?.id === flowId ? loaded : null;

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/flows/${flowId}`, { signal: ac.signal });
        if (res.ok) setLoaded(toServerFlow(((await res.json()) as ApiFlow).flow));
      } catch {
        // сервер недоступен или запрос отменён — остаёмся без серверной копии
      }
    })();
    return () => ac.abort();
  }, [flowId]);

  /** Сохраняет флоу на сервере с нужным статусом. Возвращает текст ошибки или null. */
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

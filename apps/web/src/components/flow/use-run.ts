"use client";

import { runnerEventSchema, type Flow, type Json, type RunnerEvent } from "@fl0w/schema";
import { useCallback, useRef, useState } from "react";
import type { NodeRunStatus } from "./run-status";

export type RunStatus = "idle" | "running" | "done" | "error" | "aborted";

/** Сколько последних строк лога держим в памяти вкладки. */
const MAX_LOG_LINES = 500;

/** Данные ноды в последнем запуске, где она участвовала: что пришло, с какими параметрами, что вышло, лог и ошибка. */
export type NodeDetail = {
  input?: Record<string, Json>;
  params?: Record<string, Json>;
  output?: Record<string, Json>;
  error?: string;
  logs: string[];
};

/** Сколько строк лога одной ноды держим для просмотра. */
const MAX_DETAIL_LOGS = 200;

export type RunState = {
  status: RunStatus;
  nodes: Record<string, NodeRunStatus>;
  nodeErrors: Record<string, string>;
  logs: { nodeId: string; message: string }[];
  logsDropped: number;
  /** По id ноды; новый запуск не стирает данные нод, до которых он ещё не дошёл. */
  nodeDetails: Record<string, NodeDetail>;
  result?: Json;
  error?: string;
};

export const IDLE_RUN: RunState = { status: "idle", nodes: {}, nodeErrors: {}, logs: [], logsDropped: 0, nodeDetails: {} };

/** Применяет событие запуска к состоянию (общий редьюсер для ручного запуска и Watch). */
export function reduceRun(state: RunState, e: RunnerEvent, allNodeIds: string[]): RunState {
  switch (e.event) {
    case "node:start":
      return {
        ...state,
        nodes: { ...state.nodes, [e.nodeId]: "running" },
        nodeDetails: { ...state.nodeDetails, [e.nodeId]: { input: e.input, params: e.params, logs: [] } },
      };
    case "node:log": {
      const logs = [...state.logs, { nodeId: e.nodeId, message: e.message }];
      const over = Math.max(0, logs.length - MAX_LOG_LINES);
      const d = state.nodeDetails[e.nodeId] ?? { logs: [] };
      const nodeDetails = { ...state.nodeDetails, [e.nodeId]: { ...d, logs: [...d.logs, e.message].slice(-MAX_DETAIL_LOGS) } };
      return { ...state, logs: logs.slice(over), logsDropped: state.logsDropped + over, nodeDetails };
    }
    case "node:done":
      return {
        ...state,
        nodes: { ...state.nodes, [e.nodeId]: "done" },
        nodeDetails: { ...state.nodeDetails, [e.nodeId]: { ...(state.nodeDetails[e.nodeId] ?? { logs: [] }), output: e.output } },
      };
    case "node:error":
      return {
        ...state,
        nodes: { ...state.nodes, [e.nodeId]: "error" },
        nodeErrors: { ...state.nodeErrors, [e.nodeId]: e.error },
        nodeDetails: { ...state.nodeDetails, [e.nodeId]: { ...(state.nodeDetails[e.nodeId] ?? { logs: [] }), error: e.error } },
      };
    case "flow:done": {
      if (e.error !== undefined) return { ...state, status: "error", error: e.error };
      // при успехе ноды, до которых данные не дошли (невзятая ветка), помечаем как пропущенные
      const nodes = { ...state.nodes };
      for (const id of allNodeIds) nodes[id] ??= "skipped";
      return { ...state, status: "done", nodes, result: e.result };
    }
  }
}

/** Запуск флоу через POST /api/run и разбор NDJSON-стрима событий. */
export function useRun() {
  const [state, setState] = useState<RunState>(IDLE_RUN);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(async (flow: Flow) => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    const ids = flow.nodes.map((n) => n.id);
    setState((s) => ({ ...IDLE_RUN, status: "running", nodeDetails: s.nodeDetails }));

    const fail = (error: string) =>
      setState((s) => (s.status === "running" ? { ...s, status: "error", error } : s));

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        fail(body?.error ?? `HTTP ${res.status}`);
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = runnerEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) setState((s) => reduceRun(s, parsed.data, ids));
        }
      }
      // поток закрылся без flow:done — сервер оборвался
      fail("Connection closed before the run finished");
    } catch (e) {
      if (ac.signal.aborted) setState((s) => ({ ...s, status: "aborted" }));
      else fail(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);
  // keepDetails: закрыть панель результата, не теряя данные нод для отладки
  const reset = useCallback((keepDetails = false) => setState((s) => ({ ...IDLE_RUN, nodeDetails: keepDetails ? s.nodeDetails : {} })), []);

  return { state, run, stop, reset };
}

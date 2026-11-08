"use client";

import { isLayoutBlock } from "@/lib/layout";
import { runnerEventSchema, type Flow, type Json, type RunnerEvent } from "@fl0w/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeRunStatus } from "./run-status";

export type RunStatus = "idle" | "running" | "done" | "error" | "aborted";

/** How many of the latest log lines are kept in the tab's memory. */
const MAX_LOG_LINES = 500;

/** Node data in the last run it took part in: what came in, with which params, what came out, the log and the error. */
export type NodeDetail = {
  input?: Record<string, Json>;
  params?: Record<string, Json>;
  output?: Record<string, Json>;
  /** Caption the node asked to show on itself (the number for Counter). */
  display?: string;
  error?: string;
  logs: string[];
};

/** How many log lines of a single node are kept for viewing. */
const MAX_DETAIL_LOGS = 200;

export type RunState = {
  status: RunStatus;
  nodes: Record<string, NodeRunStatus>;
  nodeErrors: Record<string, string>;
  logs: { nodeId: string; message: string }[];
  logsDropped: number;
  /** By node id; a new run does not erase the data of nodes it has not reached yet. */
  nodeDetails: Record<string, NodeDetail>;
  result?: Json;
  error?: string;
  /** The run is paused: new nodes do not start, running ones finish. */
  paused?: boolean;
};

export const IDLE_RUN: RunState = { status: "idle", nodes: {}, nodeErrors: {}, logs: [], logsDropped: 0, nodeDetails: {} };

/**
 * Start of a new run in Watch: statuses and errors of the run branch nodes (`involved` — the trigger and everything after it) are reset,
 * the other nodes stay as they were (one webhook was hit — other branches do not "go dark"). Node data (the "Data" tab) is kept
 * until overwritten when the node starts. Without `involved` nothing is reset. The feed and the result start over.
 */
export function beginWatchRun(s: RunState, involved?: string[]): RunState {
  const drop = <T,>(r: Record<string, T>) => (involved ? Object.fromEntries(Object.entries(r).filter(([id]) => !involved.includes(id))) : r);
  // the run branch (the trigger and everything after it) starts from a clean slate, the other nodes stay as they were
  return { ...IDLE_RUN, status: "running", nodes: drop(s.nodes), nodeErrors: drop(s.nodeErrors), nodeDetails: s.nodeDetails };
}

/** Applies a run event to the state (a shared reducer for manual run and Watch). */
export function reduceRun(state: RunState, e: RunnerEvent, allNodeIds: string[]): RunState {
  switch (e.event) {
    case "node:start":
      return {
        ...state,
        nodes: { ...state.nodes, [e.nodeId]: "running" },
        nodeErrors: Object.fromEntries(Object.entries(state.nodeErrors).filter(([id]) => id !== e.nodeId)),
        nodeDetails: { ...state.nodeDetails, [e.nodeId]: { input: e.input, params: e.params, logs: [], display: state.nodeDetails[e.nodeId]?.display } },
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
        nodeDetails: {
          ...state.nodeDetails,
          [e.nodeId]: { ...(state.nodeDetails[e.nodeId] ?? { logs: [] }), output: e.output, ...(e.display !== undefined ? { display: e.display } : {}) },
        },
      };
    case "node:error":
      return {
        ...state,
        nodes: { ...state.nodes, [e.nodeId]: "error" },
        nodeErrors: { ...state.nodeErrors, [e.nodeId]: e.error },
        nodeDetails: { ...state.nodeDetails, [e.nodeId]: { ...(state.nodeDetails[e.nodeId] ?? { logs: [] }), error: e.error } },
      };
    case "node:killed":
      // the node itself worked; its shoot call was aborted — shown in the feed and the error list, the node status does not change
      return {
        ...state,
        nodeErrors: { ...state.nodeErrors, [e.nodeId]: `killed: ${e.reason}` },
        logs: [...state.logs, { nodeId: e.nodeId, message: `killed: ${e.reason}` }].slice(-MAX_LOG_LINES),
      };
    case "run:paused":
      return { ...state, paused: e.paused };
    case "flow:done": {
      // nodes still "running" at the end of the run were aborted (shoot call, cancel) — they have nothing left to pulse for
      const settled = Object.fromEntries(Object.entries(state.nodes).map(([id, st]) => [id, st === "running" ? "skipped" : st])) as typeof state.nodes;
      if (e.error !== undefined) return { ...state, nodes: settled, status: "error", error: e.error, paused: false };
      // on success, nodes the data never reached (the branch not taken) are marked as skipped
      const nodes = { ...settled };
      for (const id of allNodeIds) nodes[id] ??= "skipped";
      return { ...state, status: "done", nodes, result: e.result, paused: false };
    }
  }
}

/** Running a flow via POST /api/run and parsing the NDJSON event stream. */
export function useRun() {
  const [state, setState] = useState<RunState>(IDLE_RUN);
  const controller = useRef<AbortController | null>(null);
  const runId = useRef<string | null>(null);

  const run = useCallback(async (flow: Flow, opts?: { from?: { nodeId: string; seeds: Record<string, Record<string, Json>> }; trigger?: string; others?: Flow[] }) => {
    const from = opts?.from;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    const id = crypto.randomUUID();
    runId.current = id;
    const ids = flow.nodes.filter((n) => !isLayoutBlock(n.type)).map((n) => n.id);
    setState((s) => ({ ...IDLE_RUN, status: "running", nodeDetails: s.nodeDetails }));

    const fail = (error: string) =>
      setState((s) => (s.status === "running" ? { ...s, status: "error", error } : s));

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: id, flow, ...(opts?.others?.length ? { others: opts.others } : {}), ...(from ? { from: from.nodeId, seeds: from.seeds } : {}), ...(opts?.trigger ? { trigger: opts.trigger } : {}) }),
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
      // the stream closed without flow:done — the server was cut off
      fail("Connection closed before the run finished");
    } catch (e) {
      if (ac.signal.aborted) setState((s) => ({ ...s, status: "aborted" }));
      else fail(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);
  // a closed tab must not leave a run going
  useEffect(() => () => controller.current?.abort(), []);
  const control = useCallback((action: "pause" | "resume") => {
    if (runId.current) void fetch("/api/run/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: runId.current, action }) }).catch(() => {});
  }, []);
  const pause = useCallback(() => control("pause"), [control]);
  const resume = useCallback(() => control("resume"), [control]);
  // keepDetails: close the result panel without losing node data for debugging
  const reset = useCallback((keepDetails = false) => setState((s) => ({ ...IDLE_RUN, nodeDetails: keepDetails ? s.nodeDetails : {} })), []);

  return { state, run, stop, pause, resume, reset };
}

"use client";

import { createKeyedStore } from "@/lib/keyed-store";

/** What a node shows "live" from the last run: log lines (Log terminal) and a caption instead of the icon (Counter). */
export type NodeLive = { logs: string[]; display?: string };

const store = createKeyedStore<NodeLive>();

export const NodeLogsProvider = store.Provider;

const logsOf = (v: NodeLive | undefined) => v?.logs;
const displayOf = (v: NodeLive | undefined) => v?.display;

export function useNodeLogs(nodeId: string): string[] | undefined {
  return store.useSelected(nodeId, logsOf);
}

export function useNodeDisplay(nodeId: string): string | undefined {
  return store.useSelected(nodeId, displayOf);
}

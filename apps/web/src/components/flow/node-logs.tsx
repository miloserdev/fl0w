"use client";

import { createKeyedStore } from "@/lib/keyed-store";

/** То, что нода показывает «вживую» по последнему запуску: строки лога (терминал Log) и подпись вместо иконки (Counter). */
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

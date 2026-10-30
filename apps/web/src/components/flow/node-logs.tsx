"use client";

import { createContext, useContext } from "react";

/** То, что нода показывает «вживую» по последнему запуску: строки лога (терминал Log) и подпись вместо иконки (Counter). */
export type NodeLive = { logs: string[]; display?: string };

const NodeLiveContext = createContext<Record<string, NodeLive>>({});

export const NodeLogsProvider = NodeLiveContext.Provider;

export function useNodeLogs(nodeId: string): string[] | undefined {
  return useContext(NodeLiveContext)[nodeId]?.logs;
}

export function useNodeDisplay(nodeId: string): string | undefined {
  return useContext(NodeLiveContext)[nodeId]?.display;
}

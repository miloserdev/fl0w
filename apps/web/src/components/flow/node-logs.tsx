"use client";

import { createContext, useContext } from "react";

/** Строки лога по id ноды из последнего запуска (или Watch) — их показывают нодные «терминалы» (Log) прямо на холсте. */
const NodeLogsContext = createContext<Record<string, string[]>>({});

export const NodeLogsProvider = NodeLogsContext.Provider;

export function useNodeLogs(nodeId: string): string[] | undefined {
  return useContext(NodeLogsContext)[nodeId];
}

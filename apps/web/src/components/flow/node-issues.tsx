"use client";

import { createContext, useContext } from "react";

/** nodeId → локализованные тексты проблем этой ноды (для подсветки на холсте). */
const NodeIssuesContext = createContext<Record<string, string[]>>({});

export const NodeIssuesProvider = NodeIssuesContext.Provider;

export function useNodeIssues(nodeId: string): string[] | undefined {
  return useContext(NodeIssuesContext)[nodeId];
}

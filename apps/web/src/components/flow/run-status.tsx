"use client";

import { createContext, useContext } from "react";

export type NodeRunStatus = "running" | "done" | "error" | "skipped";

const RunStatusContext = createContext<Record<string, NodeRunStatus>>({});

export const RunStatusProvider = RunStatusContext.Provider;

export function useNodeRunStatus(nodeId: string): NodeRunStatus | undefined {
  return useContext(RunStatusContext)[nodeId];
}

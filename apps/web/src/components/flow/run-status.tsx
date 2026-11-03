"use client";

import { createKeyedStore } from "@/lib/keyed-store";

export type NodeRunStatus = "running" | "done" | "error" | "skipped";

const store = createKeyedStore<NodeRunStatus>();

export const RunStatusProvider = store.Provider;

const identity = <T,>(v: T) => v;

export function useNodeRunStatus(nodeId: string): NodeRunStatus | undefined {
  return store.useSelected(nodeId, identity);
}

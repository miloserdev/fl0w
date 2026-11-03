"use client";

import { createKeyedStore } from "@/lib/keyed-store";

/** nodeId → локализованные тексты проблем этой ноды (для подсветки на холсте). */
const store = createKeyedStore<string[]>();

export const NodeIssuesProvider = store.Provider;

const identity = <T,>(v: T) => v;

export function useNodeIssues(nodeId: string): string[] | undefined {
  return store.useSelected(nodeId, identity);
}

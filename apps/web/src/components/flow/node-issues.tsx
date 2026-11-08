"use client";

import { createKeyedStore } from "@/lib/keyed-store";

/** nodeId → localized issue texts for this node (for highlighting on the canvas). */
const store = createKeyedStore<string[]>();

export const NodeIssuesProvider = store.Provider;

const identity = <T,>(v: T) => v;

export function useNodeIssues(nodeId: string): string[] | undefined {
  return store.useSelected(nodeId, identity);
}

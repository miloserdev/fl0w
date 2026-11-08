import type { FlowIssue } from "@fl0w/engine";
import { useTranslations } from "next-intl";

/** Localized text of a validation error by its `code` (the engine's fallback message is English). */
export function useIssueText() {
  const t = useTranslations("issues");
  return (i: FlowIssue): string =>
    t(i.code, {
      details: i.message,
      node: i.nodeId ?? "",
      edge: i.edgeId ?? "",
      port: i.port ?? "",
      param: i.param ?? "",
      type: i.blockType ?? "",
      nodes: i.nodeIds?.join(", ") ?? "",
    });
}

/** Nodes to highlight for the given error. */
export function issueNodeIds(i: FlowIssue): string[] {
  return i.nodeIds ?? (i.nodeId ? [i.nodeId] : []);
}

import type { FlowIssue } from "@fl0w/engine";
import { useTranslations } from "next-intl";

/** Локализованный текст ошибки валидации по её `code` (запасной message движка — английский). */
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

/** Ноды, которые нужно подсветить для данной ошибки. */
export function issueNodeIds(i: FlowIssue): string[] {
  return i.nodeIds ?? (i.nodeId ? [i.nodeId] : []);
}

import { registry } from "@fl0w/blocks";
import { useTranslations } from "next-intl";

/** Localized block name; if there is no translation, the class label. */
export function useBlockLabel() {
  const t = useTranslations("blocks");
  return (blockType: string) =>
    t.has(blockType) ? t(blockType) : (registry[blockType]?.label ?? blockType);
}

import { registry } from "@fl0w/blocks";
import { useTranslations } from "next-intl";

/** Локализованное имя блока; если перевода нет — label из класса. */
export function useBlockLabel() {
  const t = useTranslations("blocks");
  return (blockType: string) =>
    t.has(blockType) ? t(blockType) : (registry[blockType]?.label ?? blockType);
}

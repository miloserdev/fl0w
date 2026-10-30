"use client";

import { registry } from "@fl0w/blocks";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FLOATING } from "@/lib/floating";
import { cn } from "@/lib/utils";
import { BlockIcon } from "./block-icon";
import { useBlockLabel } from "./use-block-label";

const CATEGORY_ORDER = ["trigger", "io", "data", "flow", "app", "tool", "memory", "layout"];
const categoryRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

/** Окно выбора блока: типы берутся из реестра, сгруппированы по `category`. */
export function AddBlockDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (blockType: string) => void;
}) {
  const t = useTranslations();
  const blockLabel = useBlockLabel();
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const groups = new Map<string, string[]>();
  for (const [type, cls] of Object.entries(registry)) {
    const label = blockLabel(type).toLowerCase();
    if (needle && !label.includes(needle) && !type.includes(needle)) continue;
    groups.set(cls.category, [...(groups.get(cls.category) ?? []), type]);
  }

  // порядок категорий: известные — по списку, остальные — следом в порядке реестра
  const ordered = [...groups].sort(([a], [b]) => categoryRank(a) - categoryRank(b));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent className={cn(FLOATING, "max-h-[80dvh] gap-4 overflow-y-auto p-6 sm:max-w-xl")}>
        <DialogHeader>
          <DialogTitle>{t("addBlock.title")}</DialogTitle>
          <DialogDescription>{t("addBlock.description")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("addBlock.search")}
          aria-label={t("addBlock.search")}
        />
        {groups.size === 0 && <p className="text-muted-foreground text-sm">{t("addBlock.empty")}</p>}
        {ordered.map(([category, types]) => (
          <section key={category} className="flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs uppercase">
              {t.has(`categories.${category}`) ? t(`categories.${category}`) : category}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {types.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    onPick(type);
                  }}
                  className="hover:bg-accent focus-visible:ring-ring flex flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm outline-none focus-visible:ring-2"
                >
                  <BlockIcon name={registry[type]?.icon ?? ""} className="text-muted-foreground size-5" />
                  <span className="font-medium">{blockLabel(type)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}

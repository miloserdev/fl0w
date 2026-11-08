"use client";

import { registry } from "@fl0w/blocks";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
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

/** Block picker window: types come from the registry, grouped by `category`. */
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
  // block selected with the keys: index in the flat list in display order
  const [active, setActive] = useState(0);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);

  const needle = query.trim().toLowerCase();
  const groups = new Map<string, string[]>();
  for (const [type, cls] of Object.entries(registry)) {
    const label = blockLabel(type).toLowerCase();
    if (needle && !label.includes(needle) && !type.includes(needle)) continue;
    groups.set(cls.category, [...(groups.get(cls.category) ?? []), type]);
  }

  // category order: known ones by the list, the rest follow in registry order
  const ordered = [...groups].sort(([a], [b]) => categoryRank(a) - categoryRank(b));
  const flat = ordered.flatMap(([, types]) => types);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  // the selected tile is always in the visible part of the window
  useEffect(() => {
    tiles.current.length = flat.length; // after filtering only the shown tiles remain
    tiles.current[current]?.scrollIntoView({ block: "nearest" });
    // flat is recreated on every render; depend on what actually changes the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, query, open]);

  /** Neighbouring tile up/down on screen: the nearest in the next row, with the nearest horizontal centre. */
  const vertical = (dir: 1 | -1) => {
    const from = tiles.current[current]?.getBoundingClientRect();
    if (!from) return;
    const cx = from.left + from.width / 2;
    let best = -1;
    let bestScore = Infinity;
    tiles.current.forEach((el, i) => {
      if (!el || i === current) return;
      const r = el.getBoundingClientRect();
      const dy = dir === 1 ? r.top - from.top : from.top - r.top;
      if (dy < from.height / 2) return; // same row or not in the right direction
      const score = dy * 1000 + Math.abs(r.left + r.width / 2 - cx);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) setActive(best);
  };
  const pick = (type: string) => {
    setQuery("");
    setActive(0);
    onPick(type);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          setActive(0);
        }
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
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              vertical(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
              e.preventDefault();
              setActive(Math.min(current + 1, flat.length - 1));
            } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0 && current > 0) {
              e.preventDefault();
              setActive(current - 1);
            } else if (e.key === "Enter" && flat[current]) {
              e.preventDefault();
              pick(flat[current]!);
            }
          }}
          placeholder={t("addBlock.search")}
          aria-label={t("addBlock.search")}
          role="combobox"
          aria-expanded
          aria-controls="add-block-list"
          aria-activedescendant={flat[current] ? `add-block-${flat[current]}` : undefined}
        />
        {groups.size === 0 && <p className="text-muted-foreground text-sm">{t("addBlock.empty")}</p>}
        {ordered.map(([category, types]) => (
          <section key={category} id={category === ordered[0]?.[0] ? "add-block-list" : undefined} role="listbox" aria-label={t.has(`categories.${category}`) ? t(`categories.${category}`) : category} className="flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs uppercase">
              {t.has(`categories.${category}`) ? t(`categories.${category}`) : category}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {types.map((type) => (
                <button
                  key={type}
                  id={`add-block-${type}`}
                  ref={(el) => {
                    tiles.current[flat.indexOf(type)] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={flat[current] === type}
                  tabIndex={-1}
                  onClick={() => pick(type)}
                  onMouseMove={() => flat[current] !== type && setActive(flat.indexOf(type))}
                  className={cn(
                    "hover:bg-accent focus-visible:ring-ring flex flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm outline-none focus-visible:ring-2",
                    flat[current] === type && "bg-accent ring-ring ring-2",
                  )}
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

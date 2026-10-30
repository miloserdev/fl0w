"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ServerFlow = {
  id: string;
  name: string;
  status: "draft" | "published";
  triggers: { id: string; type: string }[];
};

/** Серверные флоу для выбора цели блока Run Flow; null — список ещё грузится или недоступен. */
function useServerFlows(): [ServerFlow[] | null, () => void] {
  const [flows, setFlows] = useState<ServerFlow[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/flows", { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ flows: ServerFlow[] }>) : null))
      .then((body) => setFlows(body?.flows ?? []))
      .catch(() => {});
    return () => ac.abort();
  }, [tick]);
  // список перечитывается при фокусе в поле: целевой флоу могли сохранить или опубликовать, пока форма была открыта
  return [flows, () => setTick((n) => n + 1)];
}

/**
 * Поле id флоу или его триггера с подсказками из серверных копий (параметры `picker: "flow" | "flow-trigger"`). Ввод свободный:
 * целевой флоу можно создать и опубликовать после вызывающего — публикация нужна к моменту самого вызова (иначе ошибка ноды).
 * Для неизвестного или неопубликованного флоу показывается неблокирующая подсказка.
 */
export function FlowPicker({
  id,
  kind,
  value,
  flowId,
  invalid,
  onChange,
}: {
  id: string;
  kind: "flow" | "flow-trigger";
  value: string;
  /** Для `flow-trigger`: выбранный флоу — из его триггеров предлагается выбор. */
  flowId: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("inspector");
  const [flows, refresh] = useServerFlows();

  const target = (flows ?? []).find((f) => f.id === flowId);
  const options =
    kind === "flow"
      ? (flows ?? []).map((f) => ({ value: f.id, label: `${f.name}${f.status === "published" ? "" : ` — ${t("flowDraft")}`}` }))
      : (target?.triggers ?? []).map((tr) => ({ value: tr.id, label: tr.type }));

  // Подсказка не запрещает ввод: целевой флоу можно создать и опубликовать позже — важно, чтобы он был опубликован к моменту вызова
  let hint: string | null = null;
  if (flows && value !== "") {
    if (kind === "flow") {
      const f = flows.find((x) => x.id === value);
      if (!f) hint = t("flowUnknown");
      else if (f.status !== "published") hint = t("flowNotPublished");
    } else if (target && !target.triggers.some((x) => x.id === value)) hint = t("triggerUnknown");
  }
  // у выбранного флоу на сервере нет триггеров вообще: список пуст не из-за ошибки — объясняем, что сделать
  if (!hint && kind === "flow-trigger" && flows && target && target.triggers.length === 0) hint = t("noTriggers");
  if (!hint && kind === "flow-trigger" && flows && flowId !== "" && !target) hint = t("flowUnknownForTrigger");

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = value.trim().toLowerCase();
  const shown = options.filter((o) => query === "" || o.value.toLowerCase().includes(query) || o.label.toLowerCase().includes(query));
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open && shown.length > 0} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Input
            id={id}
            role="combobox"
            aria-expanded={open && shown.length > 0}
            aria-autocomplete="list"
            value={value}
            aria-invalid={invalid}
            spellCheck={false}
            autoComplete="off"
            placeholder={kind === "flow" ? t("pickFlow") : t("pickTrigger")}
            className="font-mono text-xs"
            onFocus={() => {
              refresh();
              setOpen(true);
            }}
            onChange={(e) => {
              onChange(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setActive((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && open && shown[active]) {
                e.preventDefault();
                pick(shown[active]!.value);
              } else if (e.key === "Escape") setOpen(false);
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          // фокус остаётся в поле: список — подсказка к вводу, а не отдельная форма
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement | null)?.id === id) e.preventDefault();
          }}
        >
          <ul role="listbox" className="flex flex-col gap-0.5">
            {shown.map((o, i) => (
              <li key={o.value} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  // mousedown, а не click: поле не успевает потерять фокус и закрыть список
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o.value);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                    i === active && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="font-mono text-xs">{o.value}</span>
                  <span className="text-muted-foreground text-xs">{o.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : <p className="text-muted-foreground text-xs">{t("pickerFree")}</p>}
    </div>
  );
}

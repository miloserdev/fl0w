"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

export type ServerFlow = {
  id: string;
  name: string;
  status: "draft" | "published";
  triggers: { id: string; type: string }[];
};

/** Серверные флоу для выбора цели блока Run Flow; null — список ещё грузится или недоступен. */
function useServerFlows(): ServerFlow[] | null {
  const [flows, setFlows] = useState<ServerFlow[] | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/flows", { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ flows: ServerFlow[] }>) : null))
      .then((body) => setFlows(body?.flows ?? []))
      .catch(() => {});
    return () => ac.abort();
  }, []);
  return flows;
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
  const flows = useServerFlows();
  const listId = `${id}-options`;

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

  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        list={listId}
        value={value}
        aria-invalid={invalid}
        spellCheck={false}
        autoComplete="off"
        placeholder={kind === "flow" ? t("pickFlow") : t("pickTrigger")}
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value} label={o.label} />
        ))}
      </datalist>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : <p className="text-muted-foreground text-xs">{t("pickerFree")}</p>}
    </div>
  );
}

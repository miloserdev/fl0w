"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
 * Выбор флоу или его триггера из серверных копий (параметры `picker: "flow" | "flow-trigger"`). Вызвать можно только
 * опубликованный флоу — черновики показаны с пометкой. Если список недоступен или пуст — обычное текстовое поле.
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

  const options =
    kind === "flow"
      ? (flows ?? []).map((f) => ({ value: f.id, label: `${f.name} (${f.id})${f.status === "published" ? "" : ` — ${t("flowDraft")}`}` }))
      : ((flows ?? []).find((f) => f.id === flowId)?.triggers ?? []).map((tr) => ({ value: tr.id, label: `${tr.id} · ${tr.type}` }));

  if (!flows || options.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <Input id={id} value={value} aria-invalid={invalid} spellCheck={false} className="font-mono text-xs" onChange={(e) => onChange(e.target.value)} />
        {flows && <p className="text-muted-foreground text-xs">{kind === "flow" ? t("noFlows") : flowId ? t("noTriggers") : t("pickFlowFirst")}</p>}
      </div>
    );
  }
  // значение, которого нет в списке (набрано вручную или флоу удалён), остаётся выбираемым
  const known = options.some((o) => o.value === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-invalid={invalid} className="w-full">
        <SelectValue placeholder={kind === "flow" ? t("pickFlow") : t("pickTrigger")} />
      </SelectTrigger>
      <SelectContent>
        {!known && value !== "" && <SelectItem value={value}>{value}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

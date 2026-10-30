"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ServerFlow = {
  id: string;
  name: string;
  status: "draft" | "published";
  triggers: { id: string; type: string }[];
  channels: { incoming: string[]; outgoing: string[] };
};

/** id флоу, который сейчас открыт в редакторе: его сохранённая копия не считается «чужой» при проверке занятости канала. */
const CurrentFlowContext = createContext<string>("");
export const CurrentFlowProvider = CurrentFlowContext.Provider;

/** Серверные флоу для подсказок о каналах; null — список ещё грузится или недоступен. */
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
  // список перечитывается при фокусе в поле: парный флоу могли сохранить, пока форма была открыта
  return [flows, () => setTick((n) => n + 1)];
}

/**
 * Поле `channelId` у phone-блоков с подсказками из серверных флоу. Для исходящего телефона предлагаются каналы, на которых
 * уже есть входящий; для входящего — каналы, которых ждёт исходящий и на которых входящего ещё нет. Ввод свободный: пару можно
 * создать позже. Занятый канал (второй входящий/исходящий на той же стороне) — предупреждение, а при сохранении — отказ сервера.
 */
export function ChannelPicker({
  id,
  kind,
  value,
  invalid,
  onChange,
}: {
  id: string;
  kind: "channel-in" | "channel-out";
  value: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("inspector");
  const [flows, refresh] = useServerFlows();
  const current = useContext(CurrentFlowContext);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const others = (flows ?? []).filter((f) => f.id !== current);
  const incomingOwner = (ch: string) => others.find((f) => f.channels.incoming.includes(ch));
  const outgoingOwner = (ch: string) => others.find((f) => f.channels.outgoing.includes(ch));
  const options =
    kind === "channel-out"
      ? others.flatMap((f) => f.channels.incoming.map((ch) => ({ value: ch, label: f.name || f.id })))
      : others.flatMap((f) => f.channels.outgoing.filter((ch) => !incomingOwner(ch)).map((ch) => ({ value: ch, label: f.name || f.id })));

  const ch = value.trim();
  let hint: string | null = null;
  if (flows && ch !== "") {
    if (kind === "channel-in" && incomingOwner(ch)) hint = t("channelTakenIn", { flow: incomingOwner(ch)!.name || incomingOwner(ch)!.id });
    else if (kind === "channel-out" && outgoingOwner(ch)) hint = t("channelTakenOut", { flow: outgoingOwner(ch)!.name || outgoingOwner(ch)!.id });
    else if (kind === "channel-out" && !incomingOwner(ch)) hint = t("channelNoPeer");
  }

  const query = ch.toLowerCase();
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
            placeholder={t("channelPlaceholder")}
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
              <li key={`${o.value}-${o.label}`} role="option" aria-selected={i === active}>
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
      <p className="text-muted-foreground text-xs">{hint ?? t("channelHint")}</p>
    </div>
  );
}

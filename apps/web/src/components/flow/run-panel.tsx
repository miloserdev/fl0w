"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/tip";
import { FLOATING } from "@/lib/floating";
import { cn } from "@/lib/utils";
import type { RunState } from "./use-run";

/** Run window: status, the Result output, node errors and logs. Sits in the right column of the editor (the selected node's data is below it). */
export function RunPanel({
  state,
  live,
  onClose,
}: {
  state: RunState;
  /** Watch is on: the window lives as long as watching is on, even when there have been no runs yet. */
  live?: { connected: boolean };
  onClose: () => void;
}) {
  const t = useTranslations("run");
  if (state.status === "idle" && !live) return null;

  const nodeErrors = Object.entries(state.nodeErrors);

  return (
    <section className={cn(FLOATING, "pointer-events-auto flex max-h-[min(45dvh,26rem)] shrink-0 flex-col overflow-hidden")}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">{live ? t("liveTitle") : t("title")}</h2>
        {live && (
          <Tip label={live.connected ? t("connected") : t("reconnecting")}>
            <span className={cn("size-2 rounded-full", live.connected ? "bg-green-500" : "bg-amber-500")} />
          </Tip>
        )}
        {state.status !== "idle" && <span className="text-muted-foreground text-xs">{t(`status.${state.status}`)}</span>}
        <Button variant="ghost" size="icon" className="ml-auto size-6" onClick={onClose} aria-label={t("close")}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-3 text-sm">
          {state.status === "idle" && live && <p className="text-muted-foreground">{t("waiting")}</p>}
          {state.error && <p className="text-destructive [overflow-wrap:anywhere]">{state.error}</p>}
          {nodeErrors.map(([id, msg]) => (
            <p key={id} className="text-destructive font-mono text-xs [overflow-wrap:anywhere]">
              {id}: {msg}
            </p>
          ))}
          {state.status === "running" && <p className="text-muted-foreground">{t("progress")}</p>}
          {state.status === "done" &&
            (state.result === undefined ? (
              <p className="text-muted-foreground">{t("noResult")}</p>
            ) : (
              <div className="flex flex-col gap-1">
                <h3 className="text-muted-foreground text-xs uppercase">{t("result")}</h3>
                <pre className="bg-muted rounded-md p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {JSON.stringify(state.result, null, 2)}
                </pre>
              </div>
            ))}
          {state.logs.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-muted-foreground text-xs uppercase">{t("logs")}</h3>
              <pre className="bg-muted rounded-md p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                {state.logs.map((l) => `[${l.nodeId}] ${l.message}`).join("\n")}
              </pre>
              {state.logsDropped > 0 && (
                <p className="text-muted-foreground text-xs">{t("logsDropped", { count: state.logsDropped })}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

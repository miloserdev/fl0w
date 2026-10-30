"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FLOATING } from "@/lib/floating";
import { cn } from "@/lib/utils";
import type { RunState } from "./use-run";

/** Окно запуска: статус, результат из Result, ошибки нод и логи. Плавает справа сверху. */
export function RunPanel({
  state,
  live,
  onClose,
}: {
  state: RunState;
  /** Включён Watch: окно живёт, пока наблюдение включено, даже когда запусков ещё не было. */
  live?: { connected: boolean };
  onClose: () => void;
}) {
  const t = useTranslations("run");
  if (state.status === "idle" && !live) return null;

  const nodeErrors = Object.entries(state.nodeErrors);

  return (
    <section className={cn(FLOATING, "absolute top-[4.25rem] right-3 z-10 flex max-h-[min(60dvh,30rem)] w-96 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden")}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">{live ? t("liveTitle") : t("title")}</h2>
        {live && (
          <span
            className={cn("size-2 rounded-full", live.connected ? "bg-green-500" : "bg-amber-500")}
            title={live.connected ? t("connected") : t("reconnecting")}
          />
        )}
        {state.status !== "idle" && <span className="text-muted-foreground text-xs">{t(`status.${state.status}`)}</span>}
        <Button variant="ghost" size="icon" className="ml-auto size-6" onClick={onClose} aria-label={t("close")}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-3 text-sm">
          {state.status === "idle" && live && <p className="text-muted-foreground">{t("waiting")}</p>}
          {state.error && <p className="text-destructive">{state.error}</p>}
          {nodeErrors.map(([id, msg]) => (
            <p key={id} className="text-destructive font-mono text-xs">
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
                <pre className="bg-muted rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
                  {JSON.stringify(state.result, null, 2)}
                </pre>
              </div>
            ))}
          {state.logs.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-muted-foreground text-xs uppercase">{t("logs")}</h3>
              <pre className="bg-muted rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
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

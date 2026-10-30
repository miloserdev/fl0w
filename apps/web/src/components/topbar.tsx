"use client";

import { Eye, FolderOpen, Play, Plus, Rocket, Save, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { IssuesMenu, type IssueEntry } from "@/components/issues-menu";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FLOATING } from "@/lib/floating";
import { Tip } from "@/components/tip";
import { cn } from "@/lib/utils";

const GROUP = cn(FLOATING, "pointer-events-auto flex items-center gap-1.5 p-1.5");

export type PublishControls = {
  published: boolean;
  /** Локальные правки отличаются от опубликованной версии. */
  dirty: boolean;
  busy: boolean;
  /** Почему публиковать нельзя (кнопка отключена, причина — в подсказке). */
  blockedBy: "issues" | "noTrigger" | null;
  onPublish: () => void;
  onUnpublish: () => void;
};

export type WatchControls = {
  on: boolean;
  /** Наблюдать можно только за опубликованным флоу. */
  available: boolean;
  connected: boolean;
  onToggle: () => void;
};

/** Плавающая панель инструментов поверх холста; между группами холст остаётся доступен. */
export function Topbar({
  runStatus,
  manualRunning,
  canRun,
  publish,
  watch,
  issues,
  onSelectIssueNode,
  onAdd,
  onRun,
  onStop,
  onSave,
  onLoad,
}: {
  /** Статус для индикатора рантайма: ручной запуск или (в режиме Watch) плановый. */
  runStatus: "idle" | "running" | "done" | "error" | "aborted";
  /** Идёт именно ручной запуск — только он останавливается кнопкой «Остановить». */
  manualRunning: boolean;
  canRun: boolean;
  publish: PublishControls;
  watch: WatchControls;
  issues: IssueEntry[];
  onSelectIssueNode: (nodeId: string) => void;
  onAdd: () => void;
  onRun: () => void;
  onStop: () => void;
  onSave: () => void;
  onLoad: (file: File) => void;
}) {
  const t = useTranslations("topbar");
  const tRun = useTranslations("run");
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <header className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-2">
      <div className={GROUP}>
        <Button size="sm" variant="secondary" onClick={onAdd}>
          <Plus className="size-4" />
          {t("add")}
        </Button>
        {manualRunning ? (
          <Button size="sm" variant="destructive" onClick={onStop}>
            <Square className="size-4" />
            {t("stop")}
          </Button>
        ) : (
          <Button size="sm" onClick={onRun} disabled={!canRun} title={watch.on && publish.published ? t("runDisabledWatching") : undefined}>
            <Play className="size-4" />
            {t("run")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onSave}>
          <Save className="size-4" />
          {t("save")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <FolderOpen className="size-4" />
          {t("load")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoad(file);
            e.target.value = "";
          }}
        />
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        {/* тумблер, как «Наблюдать»: опубликован — нажата, зелёный индикатор и надпись «Опубликован» */}
        <Button
          size="sm"
          variant={publish.published ? "secondary" : "outline"}
          aria-pressed={publish.published}
          disabled={publish.busy || (!publish.published && publish.blockedBy !== null)}
          onClick={publish.published ? publish.onUnpublish : publish.onPublish}
          title={
            publish.published
              ? t("unpublish")
              : publish.blockedBy
                ? t(`publishBlocked.${publish.blockedBy}`)
                : undefined
          }
        >
          <Rocket className="size-4" />
          {publish.published ? t("published") : t("publish")}
          {publish.published && <span className="size-2 rounded-full bg-green-500" />}
        </Button>
        {publish.published && publish.dirty && (
          <Button size="sm" onClick={publish.onPublish} disabled={publish.busy || publish.blockedBy !== null} title={t("unpublishedChanges")}>
            {t("update")}
          </Button>
        )}
        <Button
          size="sm"
          variant={watch.on ? "secondary" : "outline"}
          aria-pressed={watch.on}
          disabled={!watch.available}
          onClick={watch.onToggle}
          title={watch.available ? undefined : t("watchUnavailable")}
        >
          <Eye className="size-4" />
          {t("watch")}
          {watch.on && (
            <Tip label={watch.connected ? t("live") : t("reconnecting")}>
            <span className="relative flex size-2">
              {watch.connected && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-500 opacity-75" />
              )}
              <span className={cn("relative inline-flex size-2 rounded-full", watch.connected ? "bg-green-500" : "bg-amber-500")} />
            </span>
            </Tip>
          )}
        </Button>
        <IssuesMenu issues={issues} onSelectNode={onSelectIssueNode} />
        <span className="text-muted-foreground mx-1 hidden text-sm md:inline">
          {t("runtime")}: {tRun(`status.${runStatus}`)}
        </span>
      </div>
      <div className={GROUP}>
        <LocaleSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}

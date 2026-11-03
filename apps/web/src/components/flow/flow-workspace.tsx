"use client";

import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Flow } from "@fl0w/schema";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { newFlowId } from "@/lib/flow-convert";
import { cn } from "@/lib/utils";
import {
  MAX_TABS,
  closeTab,
  loadTabs,
  moveActive,
  nextName,
  openTab,
  otherFlows,
  removeFlow,
  renameTab,
  saveTabs,
  writeFlow,
  type Tab,
  type TabsState,
} from "@/lib/workspace";
import { FlowEditor, type EditorInfo } from "./flow-editor";

type ServerEntry = { id: string; name: string; status: "draft" | "published" };

/**
 * Рабочее пространство: несколько флоу во вкладках. Каждая вкладка — отдельный смонтированный редактор со своим холстом и запуском;
 * неактивные скрыты, но продолжают жить. Опубликованные флоу работают на сервере независимо от открытых вкладок и вызывают друг друга по каналам.
 */
export function FlowWorkspace() {
  const t = useTranslations("tabs");
  const [state, setState] = useState<TabsState | null>(null);
  /** Версия содержимого вкладки: меняется, когда флоу в ней заменён целиком (открытие файла) — редактор перемонтируется. */
  const [revs, setRevs] = useState<Record<string, number>>({});
  const [infos, setInfos] = useState<Record<string, EditorInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerEntry[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const stateRef = useRef<TabsState | null>(null);

  // Восстановление после гидратации (на сервере localStorage нет): в таймере — не setState внутри эффекта.
  useEffect(() => {
    const timer = setTimeout(() => setState(loadTabs(localStorage, () => ({ id: newFlowId(), name: "flow" }))), 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    stateRef.current = state;
    if (state) saveTabs(localStorage, state);
  }, [state]);

  const update = useCallback((fn: (s: TabsState) => TabsState) => setState((s) => (s ? fn(s) : s)), []);

  const onInfo = useCallback((info: EditorInfo) => {
    setInfos((m) => {
      const cur = m[info.id];
      return cur && cur.hasServerCopy === info.hasServerCopy && cur.published === info.published && cur.nodeCount === info.nodeCount && cur.running === info.running
        ? m
        : { ...m, [info.id]: info };
    });
  }, []);

  const addTab = (tab: Tab) => {
    if (stateRef.current && stateRef.current.tabs.length >= MAX_TABS && !stateRef.current.tabs.some((x) => x.id === tab.id)) {
      setError(t("tooMany", { max: MAX_TABS }));
      return;
    }
    setError(null);
    update((s) => openTab(s, tab));
  };

  const newTab = () => addTab({ id: newFlowId(), name: nextName(stateRef.current?.tabs ?? []) });

  /** Флоу из файла: уже открытый с тем же id заменяется целиком (как раньше), иначе открывается новая вкладка. */
  const openFile = (flow: Flow) => {
    const cur = stateRef.current;
    if (cur && !cur.tabs.some((x) => x.id === flow.id) && cur.tabs.length >= MAX_TABS) return setError(t("tooMany", { max: MAX_TABS }));
    writeFlow(localStorage, flow);
    setRevs((r) => ({ ...r, [flow.id]: (r[flow.id] ?? 0) + 1 }));
    setError(null);
    update((s) => renameTab(openTab(s, { id: flow.id, name: flow.name }), flow.id, flow.name));
  };

  const openFromServer = async (id: string) => {
    if (stateRef.current?.tabs.some((x) => x.id === id)) return update((s) => moveActive(s, id));
    try {
      const res = await fetch(`/api/flows/${id}`);
      const body = (await res.json()) as { flow?: Flow; error?: string };
      if (!res.ok || !body.flow) return setError(body.error ?? `HTTP ${res.status}`);
      writeFlow(localStorage, body.flow);
      addTab({ id: body.flow.id, name: body.flow.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadServerList = async () => {
    try {
      const res = await fetch("/api/flows");
      setServer(res.ok ? ((await res.json()) as { flows: ServerEntry[] }).flows : []);
    } catch {
      setServer([]);
    }
  };

  const close = (id: string) => {
    const info = infos[id];
    // несохранённый на сервере флоу с содержимым пропадёт вместе с вкладкой — спрашиваем
    if (info && !info.hasServerCopy && info.nodeCount > 0 && !window.confirm(t("confirmClose"))) return;
    removeFlow(localStorage, id);
    setInfos((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)));
    const fresh = { id: newFlowId(), name: nextName((stateRef.current?.tabs ?? []).filter((x) => x.id !== id)) };
    update((s) => closeTab(s, id, fresh));
  };

  if (!state) return <div className="h-dvh w-full" />;

  return (
    <div className="flex h-dvh w-full flex-col">
      <div role="tablist" aria-label={t("label")} className="bg-muted/40 flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-2 pt-1">
        {state.tabs.map((tab) => {
          const info = infos[tab.id];
          const active = tab.id === state.active;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              data-tab-id={tab.id}
              className={cn(
                "group flex h-8 max-w-56 min-w-24 shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-sm",
                active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/60 cursor-pointer border-transparent",
              )}
              onClick={() => update((s) => moveActive(s, tab.id))}
              onDoubleClick={() => setRenaming(tab.id)}
              onAuxClick={(e) => e.button === 1 && close(tab.id)}
            >
              {info?.running && <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" title={t("running")} />}
              {!info?.running && info?.published && <span className="size-2 shrink-0 rounded-full bg-green-500" title={t("published")} />}
              {renaming === tab.id ? (
                <input
                  autoFocus
                  defaultValue={tab.name}
                  aria-label={t("rename")}
                  className="w-full min-w-0 bg-transparent outline-none"
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    update((s) => renameTab(s, tab.id, e.target.value));
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="truncate" title={tab.name}>
                  {tab.name}
                </span>
              )}
              <button
                type="button"
                aria-label={t("close")}
                title={t("close")}
                className="hover:bg-accent ml-auto shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  close(tab.id);
                }}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        <DropdownMenu onOpenChange={(open) => open && void loadServerList()}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="mb-0.5 h-7 shrink-0 gap-0.5 px-1.5" aria-label={t("new")} title={t("new")}>
              <Plus className="size-4" />
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-56">
            <DropdownMenuItem onSelect={newTab}>
              <Plus className="size-4" />
              {t("newFlow")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">{t("fromServer")}</DropdownMenuLabel>
            {server === null && <div className="text-muted-foreground px-2 py-1.5 text-sm">{t("loading")}</div>}
            {server?.length === 0 && <div className="text-muted-foreground px-2 py-1.5 text-sm">{t("noServerFlows")}</div>}
            {server?.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => void openFromServer(f.id)}>
                {state.tabs.some((x) => x.id === f.id) ? <Check className="size-4" /> : <span className="size-4" />}
                <span className="truncate">{f.name}</span>
                {f.status === "published" && <span className="ml-auto size-2 shrink-0 rounded-full bg-green-500" title={t("published")} />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <div className="text-destructive bg-background flex items-center gap-2 border-b px-3 py-1 text-sm">
          <span className="flex-1">{error}</span>
          <button type="button" aria-label={t("dismiss")} onClick={() => setError(null)}>
            <X className="size-4" />
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {state.tabs.map((tab) => (
          <div key={`${tab.id}:${revs[tab.id] ?? 0}`} className={cn("absolute inset-0", tab.id !== state.active && "hidden")}>
            <FlowEditor
              flowId={tab.id}
              name={tab.name}
              active={tab.id === state.active}
              onRename={(name) => update((s) => renameTab(s, tab.id, name))}
              onInfo={onInfo}
              onOpenFile={openFile}
              getOthers={() => otherFlows(localStorage, stateRef.current?.tabs ?? [], tab.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

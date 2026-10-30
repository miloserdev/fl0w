"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import type { BlockNodeType } from "@/lib/flow-convert";
import { cn } from "@/lib/utils";
import { Resizer } from "./layout-nodes";
import { useNodeLogs } from "./node-logs";
import { useNodeIssues } from "./node-issues";
import { useNodeRunStatus } from "./run-status";

/** Цвет строки по префиксу уровня, который ставит блок Log. */
export function lineTone(line: string): string {
  if (line.startsWith("[error]")) return "text-red-400";
  if (line.startsWith("[warn]")) return "text-amber-300";
  return "text-emerald-300";
}

/**
 * Нода Log на холсте: чёрное окошко как терминал. В нём строки лога последнего запуска этой ноды; ждущее состояние —
 * приглашение `$`. Тянется за уголок (размер в params), колесо мыши внутри окна прокручивает строки, а не масштабирует холст.
 */
export function TerminalNode({ id, selected }: NodeProps<BlockNodeType>) {
  const t = useTranslations("node");
  const lines = useNodeLogs(id);
  const status = useNodeRunStatus(id);
  const issues = useNodeIssues(id);
  const body = useRef<HTMLDivElement>(null);

  // новые строки — внизу, как в настоящем терминале: окно прокручивается к последней
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [lines]);

  return (
    <div
      data-node-id={id}
      className={cn(
        "fl-terminal flex size-full flex-col overflow-hidden rounded-md border-2 border-neutral-700 bg-black font-mono text-xs shadow-md",
        selected && "ring-ring ring-offset-background ring-2 ring-offset-2",
        status === "running" && "fl-pulse border-blue-500",
        status === "done" && "border-green-500",
        status === "error" && "border-destructive",
        (issues ?? null) && "border-destructive",
      )}
    >
      <Resizer id={id} selected={selected} />
      <Handle id="in0" type="target" position={Position.Left} />
      <Handle id="out0" type="source" position={Position.Right} />
      <div className="flex h-5 shrink-0 items-center gap-1.5 border-b border-neutral-800 bg-neutral-900 px-2">
        <span className="size-2 rounded-full bg-red-500/80" />
        <span className="size-2 rounded-full bg-amber-400/80" />
        <span className="size-2 rounded-full bg-emerald-500/80" />
        <span className="ml-1 truncate text-[10px] text-neutral-400">{t("terminalTitle")}</span>
      </div>
      <div ref={body} className="nodrag nowheel nopan min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {lines && lines.length > 0 ? (
          lines.map((line, i) => (
            <div key={i} className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", lineTone(line))}>
              <span className="text-neutral-500 select-none">$ </span>
              {line}
            </div>
          ))
        ) : (
          <div className="text-neutral-500">
            <span className="select-none">$ </span>
            {t("terminalIdle")}
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neutral-500 align-middle" />
          </div>
        )}
      </div>
    </div>
  );
}

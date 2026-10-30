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
  if (line.startsWith("[error]")) return "text-destructive";
  if (line.startsWith("[warn]")) return "text-amber-600 dark:text-amber-300";
  return "";
}

/**
 * Нода Log на холсте: как остальные блоки (те же скругления, цвет карточки, рамка состояния запуска), но с моноширинным
 * текстом строк лога последнего запуска и приглашением `$`. Тянется за уголок (минимум задан схемой параметров), строки
 * прокручиваются внутри, колесо мыши там не масштабирует холст.
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
        "fl-node bg-card text-card-foreground relative flex size-full flex-col overflow-hidden rounded-xl border-2 font-mono text-xs shadow-sm transition-colors",
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
      <div ref={body} className="nodrag nowheel nopan min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {lines && lines.length > 0 ? (
          lines.map((line, i) => (
            <div key={i} className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", lineTone(line))}>
              <span className="text-muted-foreground select-none">$ </span>
              {line}
            </div>
          ))
        ) : (
          <div className="text-muted-foreground">
            <span className="select-none">$ </span>
            {t("terminalIdle")}
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" />
          </div>
        )}
      </div>
    </div>
  );
}

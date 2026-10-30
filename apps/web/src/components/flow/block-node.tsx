"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { registry } from "@fl0w/blocks";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { getPorts, type BlockNodeType } from "@/lib/flow-convert";
import { scopeCss } from "@/lib/scope-css";
import { BlockIcon } from "./block-icon";
import { useNodeIssues } from "./node-issues";
import { useNodeRunStatus } from "./run-status";
import { useBlockLabel } from "./use-block-label";

const MIN_HEIGHT = 64;
const PORT_GAP = 22;

// Цвет иконки по категории блока — ориентир на холсте, как в n8n.
const ACCENT: Record<string, string> = {
  trigger: "text-amber-500",
  io: "text-sky-500",
  data: "text-violet-500",
  flow: "text-emerald-500",
  app: "text-cyan-500",
};

/** Позиция i-го из n портов: равномерно по высоте блока. */
const portTop = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;

/**
 * Нода как в n8n: квадрат с иконкой по центру, подпись под ним (вне блока), порты по бокам.
 * Состояние запуска читается по рамке (и пульсации во время работы), текст статуса не выводится.
 * Контейнер `data-node-id` и есть блок — `&` в CSS ноды относится к нему.
 */
export function BlockNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const t = useTranslations("node");
  const tPorts = useTranslations("ports");
  const blockLabel = useBlockLabel();
  /** Подпись порта: перевод из словаря, иначе label из класса блока. */
  const portLabel = (portId: string, fallback?: string) =>
    tPorts.has(`${data.blockType}.${portId}`) ? tPorts(`${data.blockType}.${portId}`) : fallback;
  const runStatus = useNodeRunStatus(id);
  const issues = useNodeIssues(id);
  const cls = registry[data.blockType];
  const ports = getPorts(data.blockType, data.portsOverride);
  const rows = Math.max(ports.inputs.length, ports.outputs.length, 1);
  const css = scopeCss(data.cssOverride ?? cls?.defaultCss ?? "", id);
  // как в n8n: у стартовых нод (есть выход, нет входа) скруглена левая сторона, у финальных (вход без выхода) — правая
  const isStart = ports.inputs.length === 0 && ports.outputs.length > 0;
  const isEnd = ports.inputs.length > 0 && ports.outputs.length === 0;
  const label = cls ? blockLabel(data.blockType) : t("unknown", { type: data.blockType });

  return (
    <div
      data-node-id={id}
      className={cn(
        "fl-node bg-card text-card-foreground relative flex w-16 items-center justify-center rounded-xl border-2 shadow-sm transition-colors",
        isStart && "rounded-l-[24px]",
        isEnd && "rounded-r-[24px]",
        selected && "ring-ring ring-offset-background ring-2 ring-offset-2",
        runStatus === "running" && "fl-pulse border-blue-500",
        runStatus === "done" && "border-green-500",
        runStatus === "error" && "border-destructive",
        runStatus === "skipped" && "opacity-50",
        (!cls || issues) && "border-destructive",
      )}
      style={{ height: Math.max(MIN_HEIGHT, rows * PORT_GAP + 20) }}
    >
      {css && <style>{css}</style>}

      <BlockIcon name={cls?.icon ?? ""} className={cn("fl-node-icon size-7", ACCENT[cls?.category ?? ""] ?? "text-muted-foreground")} />

      {issues && (
        <span
          title={issues.join("\n")}
          className="bg-destructive text-background absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full"
        >
          <TriangleAlert className="size-3" />
          <span className="sr-only">{issues.join(". ")}</span>
        </span>
      )}
      {runStatus && <span className="sr-only">{t(`status.${runStatus}`)}</span>}

      {ports.inputs.map((p, i) => (
        <Handle key={p.id} id={p.id} type="target" position={Position.Left} style={{ top: portTop(i, ports.inputs.length) }} />
      ))}
      {ports.outputs.map((p, i) => (
        <Handle key={p.id} id={p.id} type="source" position={Position.Right} style={{ top: portTop(i, ports.outputs.length) }} />
      ))}

      {/* подписи портов (true/false у Branch) — снаружи, рядом с точкой */}
      {ports.inputs.map(
        (p, i) =>
          p.label && (
            <span
              key={`l-${p.id}`}
              className="text-muted-foreground pointer-events-none absolute right-full mr-2.5 -translate-y-1/2 text-[10px] whitespace-nowrap"
              style={{ top: portTop(i, ports.inputs.length) }}
            >
              {portLabel(p.id, p.label)}
            </span>
          ),
      )}
      {ports.outputs.map(
        (p, i) =>
          p.label && (
            <span
              key={`l-${p.id}`}
              className="text-muted-foreground pointer-events-none absolute left-full ml-2.5 -translate-y-1/2 text-[10px] whitespace-nowrap"
              style={{ top: portTop(i, ports.outputs.length) }}
            >
              {portLabel(p.id, p.label)}
            </span>
          ),
      )}

      <span className="fl-node-label pointer-events-none absolute top-full left-1/2 mt-1.5 -translate-x-1/2 text-xs font-medium whitespace-nowrap">
        {label}
      </span>
    </div>
  );
}

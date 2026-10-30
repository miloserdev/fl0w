"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { registry } from "@fl0w/blocks";
import { Pin, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Tip } from "@/components/tip";
import { cn } from "@/lib/utils";
import { getPorts, splitPorts, type BlockNodeType } from "@/lib/flow-convert";
import { scopeCss } from "@/lib/scope-css";
import { BlockIcon } from "./block-icon";
import { useNodeDisplay } from "./node-logs";
import { useNodeIssues } from "./node-issues";
import { useNodeRunStatus } from "./run-status";
import { useBlockLabel } from "./use-block-label";

const MIN_HEIGHT = 64;
const PORT_GAP = 22;
/** Ширина хозяина на один ресурсный порт (ромб + подпись). */
const RESOURCE_SLOT = 110;

// Цвет иконки по категории блока — ориентир на холсте, как в n8n.
const ACCENT: Record<string, string> = {
  trigger: "text-amber-500",
  io: "text-sky-500",
  data: "text-violet-500",
  flow: "text-emerald-500",
  app: "text-cyan-500",
  tool: "text-teal-500",
  memory: "text-fuchsia-500",
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
  // нода может просить показать на себе короткий текст вместо иконки (число у Counter)
  const display = useNodeDisplay(id);
  const issues = useNodeIssues(id);
  const cls = registry[data.blockType];
  const ports = getPorts(data.blockType, data.portsOverride);
  // порты данных — по бокам; ресурсные — ромбы снизу (у хозяина) или сверху (у самого ресурса)
  const { dataIn, dataOut, resourceIn, resourceOut } = splitPorts(ports);
  const isResource = Boolean(cls?.resource);
  const rows = Math.max(dataIn.length, dataOut.length, 1);
  const css = scopeCss(data.cssOverride ?? cls?.defaultCss ?? "", id);
  // как в n8n: у стартовых нод (есть выход, нет входа) скруглена левая сторона, у финальных (вход без выхода) — правая;
  // считаем только по портам данных
  const isStart = dataIn.length === 0 && dataOut.length > 0;
  const isEnd = dataIn.length > 0 && dataOut.length === 0;
  const label = cls ? blockLabel(data.blockType) : t("unknown", { type: data.blockType });
  const hostWidth = resourceIn.length > 0 ? Math.max(MIN_HEIGHT, resourceIn.length * RESOURCE_SLOT) : undefined;
  const resLeft = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;

  return (
    <div
      data-node-id={id}
      className={cn(
        "fl-node bg-card text-card-foreground relative flex items-center justify-center border-2 shadow-sm transition-colors",
        hostWidth ? "" : "w-16",
        isResource ? "rounded-full" : "rounded-xl",
        !isResource && isStart && "rounded-l-[24px]",
        !isResource && isEnd && "rounded-r-[24px]",
        selected && "ring-ring ring-offset-background ring-2 ring-offset-2",
        runStatus === "running" && "fl-pulse border-blue-500",
        runStatus === "done" && "border-green-500",
        runStatus === "error" && "border-destructive",
        runStatus === "skipped" && !isResource && "opacity-50",
        (!cls || issues) && "border-destructive",
      )}
      style={{ height: isResource ? MIN_HEIGHT : Math.max(MIN_HEIGHT, rows * PORT_GAP + 20), width: hostWidth }}
    >
      {css && <style>{css}</style>}

      {display !== undefined ? (
        <span
          className={cn(
            "fl-node-icon max-w-full truncate px-1 text-center font-semibold tabular-nums",
            display.length > 5 ? "text-xs" : display.length > 3 ? "text-base" : "text-2xl",
            ACCENT[cls?.category ?? ""] ?? "text-muted-foreground",
          )}
        >
          {display}
        </span>
      ) : (
        <BlockIcon name={cls?.icon ?? ""} className={cn("fl-node-icon size-7", ACCENT[cls?.category ?? ""] ?? "text-muted-foreground")} />
      )}

      {issues && (
        <Tip label={issues.join("\n")}>
          <span className="bg-destructive text-background absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full">
            <TriangleAlert className="size-3" />
            <span className="sr-only">{issues.join(". ")}</span>
          </span>
        </Tip>
      )}
      {data.pinData && (
        <Tip label={t("pinned")}>
          <span className="bg-primary text-primary-foreground absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full">
            <Pin className="size-3" />
            <span className="sr-only">{t("pinned")}</span>
          </span>
        </Tip>
      )}
      {runStatus && <span className="sr-only">{t(`status.${runStatus}`)}</span>}

      {dataIn.map((p, i) => (
        <Handle key={p.id} id={p.id} type="target" position={Position.Left} style={{ top: portTop(i, dataIn.length) }} />
      ))}
      {dataOut.map((p, i) => (
        <Handle key={p.id} id={p.id} type="source" position={Position.Right} style={{ top: portTop(i, dataOut.length) }} />
      ))}

      {/* ресурсные порты: у ресурса — выход сверху, у хозяина — входы снизу с подписями-чипами */}
      {resourceOut.map((p, i) => (
        <Handle
          key={p.id}
          id={p.id}
          type="source"
          position={Position.Top}
          className={cn("fl-diamond", `fl-${p.kind}`)}
          style={{ left: resLeft(i, resourceOut.length) }}
        />
      ))}
      {resourceIn.map((p, i) => (
        <Handle
          key={p.id}
          id={p.id}
          type="target"
          position={Position.Bottom}
          className={cn("fl-diamond", `fl-${p.kind}`)}
          style={{ left: resLeft(i, resourceIn.length) }}
        />
      ))}
      {resourceIn.map((p, i) => (
        <span
          key={`rl-${p.id}`}
          className="text-muted-foreground bg-muted pointer-events-none absolute top-full mt-2 -translate-x-1/2 rounded-full px-1.5 text-[10px] whitespace-nowrap"
          style={{ left: resLeft(i, resourceIn.length) }}
        >
          {portLabel(p.id, p.label ?? p.id)}
        </span>
      ))}

      {/* подписи портов (true/false у Branch) — снаружи, рядом с точкой */}
      {dataIn.map(
        (p, i) =>
          p.label && (
            <span
              key={`l-${p.id}`}
              className="text-muted-foreground pointer-events-none absolute right-full mr-2.5 -translate-y-1/2 text-[10px] whitespace-nowrap"
              style={{ top: portTop(i, dataIn.length) }}
            >
              {portLabel(p.id, p.label)}
            </span>
          ),
      )}
      {dataOut.map(
        (p, i) =>
          p.label && (
            <span
              key={`l-${p.id}`}
              className="text-muted-foreground pointer-events-none absolute left-full ml-2.5 -translate-y-1/2 text-[10px] whitespace-nowrap"
              style={{ top: portTop(i, dataOut.length) }}
            >
              {portLabel(p.id, p.label)}
            </span>
          ),
      )}

      <span className={cn("fl-node-label pointer-events-none absolute top-full left-1/2 -translate-x-1/2 text-xs font-medium",
          isResource ? "w-28 text-center leading-tight" : "whitespace-nowrap",
          resourceIn.length > 0 ? "mt-8" : "mt-1.5",
        )}>
        {label}
      </span>
    </div>
  );
}

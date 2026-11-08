"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { registry } from "@fl0w/blocks";
import { Pause, Pin, Play, PowerOff, Square, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getPorts, splitPorts, type BlockNodeType } from "@/lib/flow-convert";
import { scopeCss } from "@/lib/scope-css";
import { BlockIcon } from "./block-icon";
import { useNodeDisplay } from "./node-logs";
import { useTriggerRun } from "./trigger-run";
import { useNodeIssues } from "./node-issues";
import { useNodeRunStatus } from "./run-status";
import { useBlockLabel } from "./use-block-label";

const MIN_HEIGHT = 64;
const PORT_GAP = 22;
/** Width of the host per resource port (diamond + label). */
const RESOURCE_SLOT = 110;

// Icon colour by block category — a landmark on the canvas, as in n8n.
const ACCENT: Record<string, string> = {
  trigger: "text-amber-500",
  io: "text-sky-500",
  data: "text-violet-500",
  flow: "text-emerald-500",
  app: "text-cyan-500",
  tool: "text-teal-500",
  memory: "text-fuchsia-500",
};

/** Position of the i-th of n ports: evenly along the block height. */
const portTop = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;

/**
 * A node as in n8n: a square with the icon in the centre, a caption under it (outside the block), ports on the sides.
 * The run state is read from the border (and the pulse while running), no status text is shown.
 * The `data-node-id` container is the block itself — `&` in the node's CSS refers to it.
 */
export function BlockNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const t = useTranslations("node");
  const tPorts = useTranslations("ports");
  const blockLabel = useBlockLabel();
  /** Port label: translation from the dictionary, otherwise the label from the block class. */
  const portLabel = (portId: string, fallback?: string) =>
    tPorts.has(`${data.blockType}.${portId}`) ? tPorts(`${data.blockType}.${portId}`) : fallback;
  const runStatus = useNodeRunStatus(id);
  const triggerRun = useTriggerRun();
  // a node may ask to show a short text on itself instead of the icon (the number for Counter)
  const display = useNodeDisplay(id);
  const issues = useNodeIssues(id);
  const cls = registry[data.blockType];
  const ports = getPorts(data.blockType, data.portsOverride, data.params);
  // data ports — on the sides; resource ports — diamonds at the bottom (on the host) or at the top (on the resource itself)
  const { dataIn, dataOut, resourceIn, resourceOut } = splitPorts(ports);
  const isResource = Boolean(cls?.resource);
  const rows = Math.max(dataIn.length, dataOut.length, 1);
  const css = scopeCss(data.cssOverride ?? cls?.defaultCss ?? "", id);
  // as in n8n: start nodes (have an output, no input) get a rounded left side, final ones (input without output) — the right;
  // counted by data ports only
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
        // disabled node: dimmed, dashed border — does not take part in the run
        data.disabled && "border-dashed opacity-40 grayscale",
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
      {cls?.manualStart && (
        // as with triggers in n8n: the run button to the left of the node — starts exactly this trigger, the others stay silent.
        // While a trial run is in progress, it is replaced by pause/resume and stop.
        <div className="nodrag nopan absolute top-1/2 right-full mr-2 flex -translate-y-1/2 gap-1">
          {triggerRun.running && (triggerRun.startedBy === null || triggerRun.startedBy === id) ? (
            <>
              <Button
                type="button"
                variant={triggerRun.paused ? "secondary" : "outline"}
                size="icon"
                className="size-7 rounded-full"
                title={triggerRun.paused ? t("resumeRun") : t("pauseRun")}
                aria-label={triggerRun.paused ? t("resumeRun") : t("pauseRun")}
                aria-pressed={triggerRun.paused}
                onClick={(e) => {
                  e.stopPropagation();
                  if (triggerRun.paused) triggerRun.resume();
                  else triggerRun.pause();
                }}
              >
                {triggerRun.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              </Button>
              <Button type="button" variant="outline" size="icon" className="size-7 rounded-full" title={t("stopRun")} aria-label={t("stopRun")} onClick={(e) => { e.stopPropagation(); triggerRun.stop(); }}>
                <Square className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7 rounded-full"
              disabled={triggerRun.disabled || data.disabled === true}
              title={t("runTrigger")}
              aria-label={t("runTrigger")}
              onClick={(e) => {
                e.stopPropagation();
                triggerRun.run(id);
              }}
            >
              <Play className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      {data.disabled && (
        <Tip label={t("disabled")}>
          <span className="bg-muted text-muted-foreground absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border">
            <PowerOff className="size-3" />
            <span className="sr-only">{t("disabled")}</span>
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

      {/* resource ports: on a resource — the output at the top, on the host — inputs at the bottom with chip labels */}
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

      {/* port labels (true/false on Branch) — outside, next to the dot */}
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

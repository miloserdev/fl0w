"use client";

import { NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";
import { Lock, LockOpen } from "lucide-react";
import { useEffect, useState } from "react";
import type { Json } from "@fl0w/schema";
import { layoutPalette } from "@/lib/layout";
import { cn } from "@/lib/utils";
import type { BlockNodeType } from "@/lib/flow-convert";

const MIN_WIDTH = 80;
const MIN_HEIGHT = 60;

/** Resize frame: visible on the selected node; the final size is written to params. */
export function Resizer({ id, selected }: { id: string; selected?: boolean }) {
  const { updateNodeData } = useReactFlow();
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={MIN_WIDTH}
      minHeight={MIN_HEIGHT}
      lineClassName="!border-primary/60"
      handleClassName="!size-2.5 !rounded-sm !border-primary !bg-background"
      onResizeEnd={(_, p) =>
        updateNodeData(id, (n) => ({
          params: { ...(n.data as BlockNodeType["data"]).params, width: Math.round(p.width), height: Math.round(p.height) },
        }))
      }
    />
  );
}

/** Writing a single parameter to the node. */
function useSetParam(id: string) {
  const { updateNodeData } = useReactFlow();
  return (name: string, value: Json) =>
    updateNodeData(id, (n) => ({ params: { ...(n.data as BlockNodeType["data"]).params, [name]: value } }));
}

/** Sticky note: a coloured card with text; double click edits in place. */
export function NoteNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const t = useTranslations("node");
  const setParam = useSetParam(id);
  const text = typeof data.params.text === "string" ? data.params.text : "";
  const palette = layoutPalette(data.params.color);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft !== text) setParam("text", draft);
    setDraft(null);
  };

  return (
    <div
      data-node-id={id}
      className={cn(
        "fl-note h-full w-full overflow-hidden rounded-md border p-3 text-sm shadow-sm",
        palette.note,
        selected && "ring-ring ring-offset-background ring-2 ring-offset-2",
      )}
      onDoubleClick={() => setDraft(text)}
    >
      <Resizer id={id} selected={selected} />
      {draft !== null ? (
        <textarea
          autoFocus
          value={draft}
          aria-label={t("noteText")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") commit();
          }}
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          className="nodrag nowheel nopan size-full resize-none bg-transparent outline-none"
        />
      ) : text ? (
        <p className="size-full overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
      ) : (
        <p className="opacity-50">{t("notePlaceholder")}</p>
      )}
    </div>
  );
}

/**
 * Group: a dashed frame with a title. The body does not catch the mouse (clicks go to the blocks inside and to the canvas),
 * the group is grabbed by the title (`.fl-group-title` is the node's dragHandle).
 */
export function GroupNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const t = useTranslations("node");
  const setParam = useSetParam(id);
  const title = typeof data.params.title === "string" ? data.params.title : "";
  const palette = layoutPalette(data.params.color);
  const [draft, setDraft] = useState<string | null>(null);
  const locked = data.params.locked === true;
  const { setNodes } = useReactFlow();
  // lock: a React Flow node has a draggable property — keep it in sync with the parameter (including edits from the inspector)
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.id === id && (n.draggable === false) !== locked ? { ...n, draggable: !locked } : n)));
  }, [id, locked, setNodes]);

  const commit = () => {
    if (draft !== null && draft !== title) setParam("title", draft);
    setDraft(null);
  };

  return (
    <div
      data-node-id={id}
      className={cn(
        "fl-group size-full rounded-lg border-2 border-dashed",
        palette.groupBox,
        selected && "ring-ring ring-offset-background ring-2 ring-offset-2",
      )}
    >
      {!locked && <Resizer id={id} selected={selected} />}
      <div
        className={cn("fl-group-title pointer-events-auto flex h-8 items-center px-3", locked ? "cursor-default" : "cursor-grab")}
        onDoubleClick={() => setDraft(title)}
      >
        {draft !== null ? (
          <input
            autoFocus
            value={draft}
            aria-label={t("groupTitle")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter") commit();
            }}
            className={cn("nodrag w-full bg-transparent text-sm font-medium outline-none", palette.groupTitle)}
          />
        ) : (
          <span className={cn("truncate text-sm font-medium", palette.groupTitle, !title && "opacity-50")}>
            {title || t("groupPlaceholder")}
          </span>
        )}
        <button
          type="button"
          className={cn("nodrag ml-auto shrink-0 rounded p-1 hover:bg-black/10 dark:hover:bg-white/10", palette.groupTitle, !locked && "opacity-50")}
          title={locked ? t("groupUnlock") : t("groupLock")}
          aria-label={locked ? t("groupUnlock") : t("groupLock")}
          aria-pressed={locked}
          onClick={() => setParam("locked", !locked)}
        >
          {locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

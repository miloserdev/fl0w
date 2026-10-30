"use client";

import { NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Json } from "@fl0w/schema";
import { layoutPalette } from "@/lib/layout";
import { cn } from "@/lib/utils";
import type { BlockNodeType } from "@/lib/flow-convert";

const MIN_WIDTH = 80;
const MIN_HEIGHT = 60;

/** Рамка для изменения размера: видна у выделенной ноды; итоговый размер записывается в params. */
function Resizer({ id, selected }: { id: string; selected?: boolean }) {
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

/** Запись одного параметра в ноду. */
function useSetParam(id: string) {
  const { updateNodeData } = useReactFlow();
  return (name: string, value: Json) =>
    updateNodeData(id, (n) => ({ params: { ...(n.data as BlockNodeType["data"]).params, [name]: value } }));
}

/** Стикер-заметка: цветная карточка с текстом; двойной клик — правка на месте. */
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
 * Группа: пунктирная рамка с заголовком. Тело не ловит мышь (клики идут к блокам внутри и к холсту),
 * группу берут за заголовок (`.fl-group-title` — dragHandle ноды).
 */
export function GroupNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const t = useTranslations("node");
  const setParam = useSetParam(id);
  const title = typeof data.params.title === "string" ? data.params.title : "";
  const palette = layoutPalette(data.params.color);
  const [draft, setDraft] = useState<string | null>(null);

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
      <Resizer id={id} selected={selected} />
      <div
        className="fl-group-title pointer-events-auto flex h-8 cursor-grab items-center px-3"
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
      </div>
    </div>
  );
}

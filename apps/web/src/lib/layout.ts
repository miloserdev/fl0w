import type { Node } from "@xyflow/react";
import { registry } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";

/** Блок оформления (заметка, группа): рисуется на холсте, но не участвует в запуске. */
export function isLayoutBlock(blockType: string): boolean {
  return registry[blockType]?.layout === true;
}

/** Блок, размер которого задаёт пользователь (тянет за уголок): заметки, группы, Log. Размер живёт в params.width/height. */
export function isResizableBlock(blockType: string): boolean {
  return registry[blockType]?.resizable === true;
}

/** Прямоугольник ноды в координатах холста. */
export type Box = { id: string; x: number; y: number; width: number; height: number };

/** Запасной размер обычного блока, пока React Flow его не измерил. */
const FALLBACK_SIZE = 64;

export function nodeBox(n: Pick<Node, "id" | "position" | "width" | "height" | "measured">): Box {
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? n.measured?.width ?? FALLBACK_SIZE,
    height: n.height ?? n.measured?.height ?? FALLBACK_SIZE,
  };
}

/**
 * Какие ноды «лежат в группе»: те, чей центр внутри рамки (границы включены). Сама группа не входит.
 * Вложенные группы и заметки тоже считаются — они переезжают вместе с рамкой.
 */
export function nodesInsideGroup(group: Box, others: Box[]): string[] {
  return others
    .filter((o) => {
      if (o.id === group.id) return false;
      const cx = o.x + o.width / 2;
      const cy = o.y + o.height / 2;
      return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height;
    })
    .map((o) => o.id);
}

const LAYOUT_LIMITS = { width: { min: 80, max: 4000 }, height: { min: 60, max: 4000 } } as const;

/** Нижние границы размера блока — из схемы его параметров (у Log выше, чем у заметки). */
function limit(blockType: string, key: "width" | "height") {
  const p = registry[blockType]?.params.find((x) => x.name === key);
  return p && p.type === "number" ? { min: p.min ?? LAYOUT_LIMITS[key].min, max: p.max ?? LAYOUT_LIMITS[key].max } : LAYOUT_LIMITS[key];
}

function dim(value: Json | undefined, fallback: number, key: "width" | "height", blockType: string): number {
  const v = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const { min, max } = limit(blockType, key);
  return Math.round(Math.min(max, Math.max(min, v)));
}

/** Размер блока оформления из params (с границами из схемы); без значений — размер по умолчанию класса. */
export function layoutSize(blockType: string, params: Record<string, Json>): { width: number; height: number } {
  const def = (name: string, fb: number) => {
    const p = registry[blockType]?.params.find((x) => x.name === name);
    return p && p.type === "number" && typeof p.default === "number" ? p.default : fb;
  };
  return {
    width: dim(params.width, def("width", 220), "width", blockType),
    height: dim(params.height, def("height", 140), "height", blockType),
  };
}

/** Слои холста: группы под заметками, заметки под блоками (у блоков zIndex 0). */
const LAYER_GROUP = -2;
const LAYER_NOTE = -1;

/** Свойства ноды React Flow, которые зависят от вида блока оформления (пусто — для обычного блока). */
export function layoutNodeProps(blockType: string, params: Record<string, Json>): Partial<Pick<Node, "width" | "height" | "zIndex" | "dragHandle" | "style" | "draggable">> {
  if (!isResizableBlock(blockType)) return {};
  const size = layoutSize(blockType, params);
  if (blockType === "group") {
    // под остальными; клики по пустой рамке проходят к холсту — группу берут за заголовок
    return { ...size, zIndex: LAYER_GROUP, dragHandle: ".fl-group-title", style: { pointerEvents: "none" }, ...(params.locked === true ? { draggable: false } : {}) };
  }
  // заметка лежит ПОД блоками (но над группами): иначе свежая или большая заметка перекрывала бы ноды
  if (isLayoutBlock(blockType)) return { ...size, zIndex: LAYER_NOTE };
  return size;
}

type Palette = { note: string; groupBox: string; groupTitle: string; swatch: string; mini: string };

// Классы Tailwind записаны целиком — иначе сборка их не найдёт.
export const LAYOUT_PALETTE: Record<string, Palette> = {
  yellow: {
    note: "bg-yellow-100 border-yellow-300 text-yellow-950 dark:bg-yellow-900/50 dark:border-yellow-700 dark:text-yellow-50",
    groupBox: "bg-yellow-500/10 border-yellow-500/50",
    groupTitle: "text-yellow-800 dark:text-yellow-200",
    swatch: "bg-yellow-400",
    mini: "#facc1566",
  },
  blue: {
    note: "bg-blue-100 border-blue-300 text-blue-950 dark:bg-blue-900/50 dark:border-blue-700 dark:text-blue-50",
    groupBox: "bg-blue-500/10 border-blue-500/50",
    groupTitle: "text-blue-800 dark:text-blue-200",
    swatch: "bg-blue-400",
    mini: "#3b82f666",
  },
  green: {
    note: "bg-green-100 border-green-300 text-green-950 dark:bg-green-900/50 dark:border-green-700 dark:text-green-50",
    groupBox: "bg-green-500/10 border-green-500/50",
    groupTitle: "text-green-800 dark:text-green-200",
    swatch: "bg-green-400",
    mini: "#22c55e66",
  },
  pink: {
    note: "bg-pink-100 border-pink-300 text-pink-950 dark:bg-pink-900/50 dark:border-pink-700 dark:text-pink-50",
    groupBox: "bg-pink-500/10 border-pink-500/50",
    groupTitle: "text-pink-800 dark:text-pink-200",
    swatch: "bg-pink-400",
    mini: "#ec489966",
  },
  purple: {
    note: "bg-purple-100 border-purple-300 text-purple-950 dark:bg-purple-900/50 dark:border-purple-700 dark:text-purple-50",
    groupBox: "bg-purple-500/10 border-purple-500/50",
    groupTitle: "text-purple-800 dark:text-purple-200",
    swatch: "bg-purple-400",
    mini: "#a855f766",
  },
  gray: {
    note: "bg-zinc-100 border-zinc-300 text-zinc-950 dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-50",
    groupBox: "bg-zinc-500/10 border-zinc-500/50",
    groupTitle: "text-zinc-700 dark:text-zinc-300",
    swatch: "bg-zinc-400",
    mini: "#71717a66",
  },
};

export function layoutPalette(color: Json | undefined): Palette {
  return (typeof color === "string" && LAYOUT_PALETTE[color]) || LAYOUT_PALETTE.gray!;
}

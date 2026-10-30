import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";

/** Цвета заметок и групп: UI подбирает под них оттенки для светлой и тёмной темы. */
export const LAYOUT_COLORS = ["yellow", "blue", "green", "pink", "purple", "gray"] as const;

const colorParam: ParamSchema = {
  name: "color",
  type: "enum",
  default: "yellow",
  options: LAYOUT_COLORS.map((value) => ({ value })),
};
/** Размер на холсте, px (редактор меняет его за уголок ноды). */
const sizeParams = (w: number, h: number): ParamSchema[] => [
  { name: "width", type: "number", default: w, min: 80, max: 4000 },
  { name: "height", type: "number", default: h, min: 60, max: 4000 },
];

abstract class LayoutBlock extends Block {
  static override layout = true;
  static override category = "layout";
  static override ports = { inputs: [], outputs: [] };

  async run(): Promise<Record<string, Json>> {
    throw new Error("A layout block (note, group) is not part of the data flow");
  }
}

/** Стикер-заметка: текст на холсте (поддерживает переносы строк). Не участвует в запуске. */
export class StickyNote extends LayoutBlock {
  static type = "note";
  static label = "Sticky Note";
  static icon = "sticky-note";
  static params: ParamSchema[] = [
    { name: "text", type: "string", multiline: true, default: "", expressions: false },
    { ...colorParam, default: "yellow" },
    ...sizeParams(220, 140),
  ];
}

/**
 * Группа («холст»): рамка с заголовком, объединяющая блоки в логический участок флоу. Перенос группы переносит блоки
 * внутри неё. Не участвует в запуске.
 */
export class GroupFrame extends LayoutBlock {
  static type = "group";
  static label = "Group";
  static icon = "square-dashed";
  static params: ParamSchema[] = [
    { name: "title", type: "string", default: "", expressions: false },
    { ...colorParam, default: "blue" },
    ...sizeParams(420, 260),
  ];
}

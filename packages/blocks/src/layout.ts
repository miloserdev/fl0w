import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";

/** Colours of notes and groups: the UI picks shades for them for the light and dark themes. */
export const LAYOUT_COLORS = ["yellow", "blue", "green", "pink", "purple", "gray"] as const;

const colorParam: ParamSchema = {
  name: "color",
  type: "enum",
  default: "yellow",
  options: LAYOUT_COLORS.map((value) => ({ value })),
};
/** Size on the canvas, px (the editor changes it by the node corner). */
const sizeParams = (w: number, h: number): ParamSchema[] => [
  { name: "width", type: "number", default: w, min: 80, max: 4000 },
  { name: "height", type: "number", default: h, min: 60, max: 4000 },
];

abstract class LayoutBlock extends Block {
  static override layout = true;
  static override resizable = true;
  static override category = "layout";
  static override ports = { inputs: [], outputs: [] };

  async run(): Promise<Record<string, Json>> {
    throw new Error("A layout block (note, group) is not part of the data flow");
  }
}

/** Sticky note: text on the canvas (supports line breaks). Does not take part in a run. */
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
 * Group ("canvas"): a frame with a title that joins blocks into a logical part of the flow. Moving a group moves the blocks
 * inside it. Does not take part in a run.
 */
export class GroupFrame extends LayoutBlock {
  static type = "group";
  static label = "Group";
  static icon = "square-dashed";
  static params: ParamSchema[] = [
    { name: "title", type: "string", default: "", expressions: false },
    { ...colorParam, default: "blue" },
    { name: "locked", type: "boolean", default: false, expressions: false },
    ...sizeParams(420, 260),
  ];
}

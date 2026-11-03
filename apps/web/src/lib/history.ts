import type { Edge } from "@xyflow/react";
import { sameStructure, type BlockNodeType } from "./flow-convert";

export type Doc = { nodes: BlockNodeType[]; edges: Edge[] };

/** Одинаковы ли документы для истории: структура и положение нод; выделение, размеры и перетаскивание не в счёт. */
export function sameDoc(a: Doc, b: Doc): boolean {
  if (!sameStructure(a, b)) return false;
  return a.nodes.every((n, i) => n.position.x === b.nodes[i]!.position.x && n.position.y === b.nodes[i]!.position.y);
}

/** Снимок для хранения: без выделения и признаков перетаскивания. */
export const snapshot = (d: Doc): Doc => ({
  nodes: d.nodes.map((n) => (n.selected || n.dragging ? { ...n, selected: false, dragging: false } : n)),
  edges: d.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
});

/**
 * История правок (undo/redo): стеки снимков. `commit(doc)` вызывается, когда правка «устоялась»; одинаковый с последним
 * документ в историю не попадает. Чистая логика — подключается хуком редактора.
 */
export class History {
  private past: Doc[] = [];
  private future: Doc[] = [];
  private current: Doc | null = null;

  constructor(private readonly limit = 100) {}

  /** Начать с этого документа (после загрузки флоу): история очищается. */
  reset(doc: Doc): void {
    this.past = [];
    this.future = [];
    this.current = snapshot(doc);
  }

  commit(doc: Doc): boolean {
    if (!this.current) return void this.reset(doc), false;
    if (sameDoc(this.current, doc)) return false;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.current = snapshot(doc);
    return true;
  }

  undo(): Doc | null {
    const prev = this.past.pop();
    if (!prev || !this.current) return null;
    this.future.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): Doc | null {
    const next = this.future.pop();
    if (!next || !this.current) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}

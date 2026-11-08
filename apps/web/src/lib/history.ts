import type { Edge } from "@xyflow/react";
import { sameStructure, type BlockNodeType } from "./flow-convert";

export type Doc = { nodes: BlockNodeType[]; edges: Edge[] };

/** Whether documents are the same for history: node structure and position; selection, sizes and dragging do not count. */
export function sameDoc(a: Doc, b: Doc): boolean {
  if (!sameStructure(a, b)) return false;
  return a.nodes.every((n, i) => n.position.x === b.nodes[i]!.position.x && n.position.y === b.nodes[i]!.position.y);
}

/** Snapshot for storage: without selection and dragging flags. */
export const snapshot = (d: Doc): Doc => ({
  nodes: d.nodes.map((n) => (n.selected || n.dragging ? { ...n, selected: false, dragging: false } : n)),
  edges: d.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
});

/**
 * Edit history (undo/redo): snapshot stacks. `commit(doc)` is called when an edit has "settled"; a document identical to the last
 * one does not go into history. Pure logic — plugged in by the editor hook.
 */
export class History {
  private past: Doc[] = [];
  private future: Doc[] = [];
  private current: Doc | null = null;

  constructor(private readonly limit = 100) {}

  /** Start from this document (after loading a flow): history is cleared. */
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

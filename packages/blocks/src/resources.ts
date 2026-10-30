import type { Json } from "@fl0w/schema";
import { Block, type MemoryHandle, type ToolHandle } from "./block";

/**
 * Инструмент: sub-node с выходным портом вида `tool`. Сам не запускается — хозяин (например, Code Agent) получает
 * `ToolHandle` в `ctx.tools` и вызывает `call(args)`. Параметры уже проверены и с подставленными выражениями.
 */
export abstract class ToolBlock extends Block {
  static override resource = "tool" as const;
  static override category = "tool";
  static override ports = { inputs: [], outputs: [{ id: "tool", kind: "tool" as const }] };

  abstract createTool(params: Record<string, Json>): ToolHandle;

  async run(): Promise<Record<string, Json>> {
    throw new Error("A tool is a sub-node: connect it to the tool port of another block");
  }
}

/** Банк памяти: sub-node с выходным портом вида `memory`; хозяин получает `MemoryHandle` в `ctx.memory`. */
export abstract class MemoryBlock extends Block {
  static override resource = "memory" as const;
  static override category = "memory";
  static override ports = { inputs: [], outputs: [{ id: "memory", kind: "memory" as const }] };

  abstract createMemory(params: Record<string, Json>): MemoryHandle;

  async run(): Promise<Record<string, Json>> {
    throw new Error("A memory bank is a sub-node: connect it to the memory port of another block");
  }
}

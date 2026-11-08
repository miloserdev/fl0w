import type { Json } from "@fl0w/schema";
import { Block, type MemoryHandle, type ToolHandle } from "./block";

/**
 * Tool: a sub-node with an output port of kind `tool`. It does not run by itself: the owner (for example, Code Agent) receives
 * a `ToolHandle` in `ctx.tools` and calls `call(args)`. Parameters are already validated and have expressions substituted.
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

/** Memory bank: a sub-node with an output port of kind `memory`; the owner receives a `MemoryHandle` in `ctx.memory`. */
export abstract class MemoryBlock extends Block {
  static override resource = "memory" as const;
  static override category = "memory";
  static override ports = { inputs: [], outputs: [{ id: "memory", kind: "memory" as const }] };

  /** `signal`: cancellation of the owner's run; waiting for the bank lock stops. */
  abstract createMemory(params: Record<string, Json>, signal?: AbortSignal): MemoryHandle;

  async run(): Promise<Record<string, Json>> {
    throw new Error("A memory bank is a sub-node: connect it to the memory port of another block");
  }
}

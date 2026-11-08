import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { createJsonDriver } from "./memory";

/** Bank holding the counter values (key -> number); the directory and sandbox are the same as for the memory blocks. */
const COUNTERS_BANK = "counters";

/**
 * Trigger counter: counts how many times this node ran and shows the number on the node itself instead of the icon.
 * Data passes on unchanged. The count survives runs (a file on disk; the "Run" sandbox and a working
 * published flow each have their own). `name` empty: this very node is counted; set: a shared counter with that name across all
 * nodes (supports `{{ inputs... }}`). `operation: reset` zeroes the count (the number on the node becomes 0).
 */
export class Counter extends Block {
  static type = "counter";
  static label = "Counter";
  static icon = "hash";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "name", type: "string", default: "" },
    { name: "operation", type: "enum", default: "count", options: [{ value: "count" }, { value: "reset" }] },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx?: RunContext) {
    const name = String(params["name"] ?? "").trim();
    if (name.length > 256) throw new Error("Counter name is too long (max 256 characters)");
    const op = String(params["operation"] ?? "count");
    if (op !== "count" && op !== "reset") throw new Error(`Unknown operation "${op}"`);
    // each node has its own counter: key from flow and node id; shared by name (the prefixes do not overlap)
    const key = name !== "" ? `name:${name}` : ctx?.flowId && ctx.nodeId ? `node:${ctx.flowId}/${ctx.nodeId}` : null;
    if (key === null) throw new Error("Counter needs a name when it runs outside of a flow");

    const value = await createJsonDriver(COUNTERS_BANK).update((data) => {
      const stored = Object.hasOwn(data, key) ? data[key] : 0;
      if (typeof stored !== "number" || !Number.isFinite(stored)) throw new Error("The stored counter value is not a number");
      const next = op === "reset" ? 0 : stored + 1;
      data[key] = next;
      return next;
    }, ctx?.signal);
    ctx?.display?.(String(value));
    return { out0: inputs["in0"] ?? null };
  }
}

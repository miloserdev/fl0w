import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { conditionParams, evalCondition } from "./conditions";
import { getPath } from "./json-path";

/** How many iterations are allowed per loop run (protection against an infinite `while`). */
export const DEFAULT_LOOP_ITERATIONS = 1000;
export const MAX_LOOP_ITERATIONS = 10_000;

const BODY = "body";

/**
 * Loop: a real loop. The node from the `body` port is the loop body: the engine runs it once per iteration (the iteration data
 * comes out of `body`), and when the loop ends, an array of results comes out of `out0` ("done"): the body's Result value per iteration
 * (`null` if the body has no Result). Result nodes inside the body belong to the iteration and do not go into the result of the whole run.
 *
 * Modes:
 *  - `items`: over array elements (`path` in the input, empty means the whole input): `{ item, index, total }`;
 *  - `count`: `for`: `i` from `from` while `i < to` (with a negative `step`, while `i > to`) with step `step`: `{ item: i, index, total }`;
 *  - `while`: while the condition over the PREVIOUS iteration's result (for the first, over the input) is true: `{ item: last, index }`;
 *  - `forever`: `while true`: until the Break block in the body (or the iteration limit, which is an error).
 * `maxIterations` bounds any mode (1000 by default, at most 10,000). `onError`: `stop`: an iteration error fails the loop,
 * `continue`: the iteration is skipped (no result), errors go to the `err` port (visible only in this mode; it emits only if there were errors).
 */
export class Loop extends Block {
  static type = "loop";
  static label = "Loop";
  static icon = "repeat";
  static category = "flow";
  static bodyPort = BODY;
  static ports = {
    inputs: [{ id: "in0" }],
    outputs: [{ id: "out0", label: "done" }, { id: BODY, label: "each" }],
  };
  /** With `onError: continue` an `err` port appears: errors of failed iterations (`[{ index, item, error }]`) so they are not lost. */
  static override portsFor(params: Record<string, Json>): PortsDef | null {
    return params["onError"] === "continue"
      ? { inputs: [{ id: "in0" }], outputs: [{ id: "out0", label: "done" }, { id: BODY, label: "each" }, { id: "err", label: "errors" }] }
      : null;
  }
  static params: ParamSchema[] = [
    { name: "mode", type: "enum", default: "items", options: [{ value: "items" }, { value: "count" }, { value: "while" }, { value: "forever" }] },
    { name: "path", type: "string", default: "", showWhen: { param: "mode", in: ["items"] } },
    { name: "from", type: "number", default: 0, showWhen: { param: "mode", in: ["count"] } },
    { name: "to", type: "number", default: 10, showWhen: { param: "mode", in: ["count"] } },
    { name: "step", type: "number", default: 1, showWhen: { param: "mode", in: ["count"] } },
    ...conditionParams().map((p) => ({ ...p, showWhen: { param: "mode", in: ["while"] } }) as ParamSchema),
    { name: "maxIterations", type: "number", default: DEFAULT_LOOP_ITERATIONS, min: 1, max: MAX_LOOP_ITERATIONS },
    { name: "onError", type: "enum", default: "stop", options: [{ value: "stop" }, { value: "continue" }] },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    if (!ctx.runBody) throw new Error('A Loop needs a body: connect nodes to its "each" output');
    const input = inputs["in0"] ?? null;
    const mode = String(params["mode"] ?? "items");
    const max = Math.min(Math.max(Math.trunc(Number(params["maxIterations"] ?? DEFAULT_LOOP_ITERATIONS)) || DEFAULT_LOOP_ITERATIONS, 1), MAX_LOOP_ITERATIONS);
    const keep = params["onError"] === "continue";

    // source of iterations: a "next value or end" function and the total count (if known)
    let total: number | null = null;
    let nextItem: (index: number, last: Json) => { item: Json } | null;
    if (mode === "items") {
      const path = typeof params["path"] === "string" ? params["path"].trim() : "";
      const list = path === "" ? input : getPath(input, path);
      if (!Array.isArray(list)) throw new Error(path === "" ? "The input must be an array to loop over" : `"${path}" is not an array in the input`);
      if (list.length > max) throw new Error(`Too many items to loop over (${list.length}; maxIterations is ${max})`);
      total = list.length;
      nextItem = (i) => (i < list.length ? { item: list[i]! } : null);
    } else if (mode === "count") {
      const from = Number(params["from"] ?? 0);
      const to = Number(params["to"] ?? 10);
      const step = Number(params["step"] ?? 1);
      if (![from, to, step].every(Number.isFinite)) throw new Error('"from", "to" and "step" must be numbers');
      if (step === 0) throw new Error('"step" must not be zero');
      total = Math.max(0, Math.ceil((to - from) / step));
      if (total > max) throw new Error(`Too many iterations (${total}; maxIterations is ${max})`);
      nextItem = (i) => (i < (total as number) ? { item: from + i * step } : null);
    } else if (mode === "while") {
      const field = String(params["field"] ?? "");
      const operator = String(params["operator"] ?? "truthy");
      nextItem = (_i, last) => (evalCondition(getPath(last, field), operator, params["value"]) ? { item: last } : null);
    } else if (mode === "forever") {
      nextItem = (_i, last) => ({ item: last });
    } else throw new Error(`Unknown mode "${mode}"`);

    const results: Json[] = [];
    const errors: Json[] = [];
    let last: Json = input;
    for (let index = 0; ; index++) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      const step = nextItem(index, last);
      if (step === null) break;
      if (index >= max) throw new Error(`The loop reached maxIterations (${max}) — add a Break in the body or a condition that ends it`);
      const outcome = await ctx.runBody({ item: step.item, index, total });
      if (!outcome.ok) {
        if (!keep) throw new Error(`Loop iteration ${index} failed: ${outcome.error}`);
        ctx.log(`iteration ${index} failed: ${outcome.error}`);
        errors.push({ index, item: step.item, error: outcome.error });
        continue;
      }
      results.push(outcome.result);
      last = outcome.result;
      if (outcome.broke) break;
    }
    return errors.length > 0 ? { out0: results, err: errors } : { out0: results };
  }
}

/** Break: inside a loop body stops the nearest loop after the current iteration; data passes on. */
export class LoopBreak extends Block {
  static type = "loop_break";
  static label = "Break";
  static icon = "log-out";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];

  async run(inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    if (!ctx.breakLoop) throw new Error("Break can only be used inside the body of a Loop");
    ctx.breakLoop();
    return { out0: inputs["in0"] ?? null };
  }
}

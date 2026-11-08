import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";
import { Block, triggerPayload, type RunContext } from "./block";

/**
 * A pair of calls: calling one flow from another over the channel `channelId` (strictly 1:1). The call itself runs inside the caller's
 * run (as a nested run of the called flow), so both flows end up in one runner process.
 */

/** Collector (incoming call): the entry of the called flow. Raised only by a paired outgoing call with the same `channelId`. */
export class CallTrigger extends Block {
  static type = "call_trigger";
  static label = "Collector";
  static icon = "phone-incoming";
  static category = "trigger";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [{ name: "channelId", type: "string", required: true, expressions: false, picker: "channel-in" }];
  static isTrigger = true;
  static autoTrigger = true; // publishing a flow with just an incoming phone is allowed: it lives for the sake of calls
  static eventDriven = true;
  static callOnly = true;

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    // call data as is (including null); without a call, Collector does not start
    return { out0: triggerPayload(ctx, "Incoming Call") };
  }
}

const OUT_PORTS: PortsDef = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
const OUT_PORTS_AWAIT: PortsDef = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }, { id: "err", label: "error" }] };

/**
 * Outgoing call: calls the incoming call with the same `channelId`.
 *  - `await` (with confirmation): waits for the called flow; `out0` is its result (the Result value), `err` is the error if it failed
 *    (the port is visible only in this mode; if nothing is connected to `err`, the error fails the node so it is not lost).
 *  - `shoot` (fire and forget): does not wait; `out0` = `{ ok: true }`, the fact of sending. The called flow runs in the background and is aborted if
 *    the caller's run ends earlier; the abort and failure are written to the event feed and do not affect the caller.
 */
export class RunFlow extends Block {
  static type = "run_flow";
  static label = "Emitter";
  static icon = "phone-outgoing";
  static category = "flow";
  static ports = OUT_PORTS;
  static params: ParamSchema[] = [
    { name: "channelId", type: "string", required: true, expressions: false, picker: "channel-out" },
    { name: "mode", type: "enum", default: "await", options: [{ value: "await" }, { value: "shoot" }] },
    // null means pass the whole input; otherwise JSON ({{ inputs.in0.path }} works in strings)
    { name: "data", type: "json" },
  ];

  static override portsFor(params: Record<string, Json>): PortsDef {
    return params["mode"] === "shoot" ? OUT_PORTS : OUT_PORTS_AWAIT;
  }

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    if (!ctx.call) throw new Error("Calling other flows is not available in this environment");
    const channelId = String(params["channelId"] ?? "").trim();
    if (!channelId) throw new Error("channelId is required");
    const mode = params["mode"] === "shoot" ? "shoot" : "await";
    const data = params["data"] === undefined || params["data"] === null ? (inputs["in0"] ?? null) : params["data"];
    const outcome = await ctx.call({ channelId, data, mode });

    if (mode === "shoot") return { out0: { ok: true } };
    if (outcome.ok) return { out0: outcome.result };
    // error of the called flow: via the err port; if it is connected to nothing, the node fails (no silent loss)
    if (ctx.connected?.includes("err")) return { err: { message: outcome.error, channelId } };
    throw new Error(outcome.error);
  }
}

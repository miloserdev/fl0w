import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type RunContext } from "./block";

export const WEBHOOK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"] as const;
const PATH = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

/** Path without leading/trailing slashes; null means the path is not allowed. */
export function normalizeWebhookPath(raw: string): string | null {
  const p = raw.trim().replace(/^\/+|\/+$/g, "");
  // the segments "." and ".." are collapsed by clients and proxies: the path would end up not where intended
  if (!PATH.test(p) || p.split("/").some((s) => s === "." || s === "..")) return null;
  return p;
}

/**
 * Webhook: a trigger on an incoming HTTP request to /api/hooks/<path>. Works for a published flow.
 * The output is the request: { method, path, query, headers, body }. In a manual run it gives an example request.
 * respond: onReceived: 200 right away, the flow runs in the background; whenFinished: the response after the flow finishes
 * (it is built by Respond to Webhook or Result).
 */
export class Webhook extends Block {
  static type = "webhook";
  static label = "Webhook";
  static icon = "webhook";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "path", type: "string", required: true, default: "webhook" },
    {
      name: "method",
      type: "enum",
      required: true,
      default: "POST",
      options: WEBHOOK_METHODS.map((value) => ({ value })),
    },
    {
      name: "respond",
      type: "enum",
      default: "onReceived",
      options: [{ value: "onReceived" }, { value: "whenFinished" }],
    },
  ];

  static webhook(params: Record<string, Json>) {
    const path = normalizeWebhookPath(String(params["path"] ?? ""));
    if (path === null) throw new Error(`Invalid webhook path "${String(params["path"])}"`);
    return { path, method: String(params["method"] ?? "POST") };
  }

  async run(_inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    return { out0: triggerPayload(ctx, "Webhook") };
  }
}

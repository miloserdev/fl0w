import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type RunContext } from "./block";

export const WEBHOOK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"] as const;
const PATH = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

/** Путь без ведущих/замыкающих слэшей; null — путь недопустим. */
export function normalizeWebhookPath(raw: string): string | null {
  const p = raw.trim().replace(/^\/+|\/+$/g, "");
  // сегменты «.» и «..» клиенты и прокси схлопывают — путь вышел бы не туда, куда задумано
  if (!PATH.test(p) || p.split("/").some((s) => s === "." || s === "..")) return null;
  return p;
}

/**
 * Webhook: триггер по входящему HTTP-запросу на /api/hooks/<path>. Работает у опубликованного флоу.
 * Выход — запрос: { method, path, query, headers, body }. При ручном запуске отдаёт пример запроса.
 * respond: onReceived — сразу 200, флоу идёт в фоне; whenFinished — ответ после завершения флоу
 * (его формирует Respond to Webhook или Result).
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

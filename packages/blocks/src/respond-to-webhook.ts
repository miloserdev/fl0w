import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { isPlainObject, resolveTemplates } from "./json-path";

/**
 * Respond to Webhook: формирует HTTP-ответ на запрос Webhook (режим whenFinished). Тело — параметр
 * `body` (шаблоны `{{ путь }}` берут данные из входа) или, если он пуст, сам вход.
 * Блок конечный: ответ он отдаёт хосту в служебном выходе `response`.
 */
export class RespondToWebhook extends Block {
  static type = "respond_to_webhook";
  static label = "Respond to Webhook";
  static icon = "corner-up-left";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [] };
  static override serviceOutputs = ["response"] as const; // HTTP-ответ: его читает хост по событию node:done
  static params: ParamSchema[] = [
    { name: "status", type: "number", required: true, default: 200, min: 100, max: 599 },
    { name: "body", type: "json", default: null },
    { name: "headers", type: "json", default: {} },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const input = inputs["in0"] ?? null;
    const headers = params["headers"] ?? {};
    if (!isPlainObject(headers)) throw new Error('Parameter "headers" must be an object');
    const body = params["body"] === null || params["body"] === undefined ? input : resolveTemplates(params["body"], input);
    return {
      response: {
        status: Math.floor(Number(params["status"] ?? 200)),
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
        body,
      },
    };
  }
}

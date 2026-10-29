import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { interpolate, resolveTemplates } from "./json-path";

/** Stop and Error: останавливает запуск с заданной ошибкой — текстом или объектом. Шаблоны `{{ путь }}` берут данные из входа. */
export class StopAndError extends Block {
  static type = "stop_and_error";
  static label = "Stop and Error";
  static icon = "octagon-x";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [] };
  static params: ParamSchema[] = [
    {
      name: "errorType",
      type: "enum",
      required: true,
      default: "message",
      options: [{ value: "message" }, { value: "object" }],
    },
    { name: "message", type: "string", default: "Workflow stopped" },
    { name: "errorObject", type: "json", default: {} },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>): Promise<Record<string, Json>> {
    const input = inputs["in0"] ?? null;
    if (params["errorType"] === "object") {
      throw new Error(JSON.stringify(resolveTemplates(params["errorObject"] ?? {}, input)));
    }
    const msg = interpolate(String(params["message"] ?? ""), input);
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
}

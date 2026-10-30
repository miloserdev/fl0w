import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";

/**
 * Вход «Вызов из флоу»: триггер, который запускается другим флоу (блоком Run Flow) с переданными данными.
 * В ручном запуске не стартует (как все триггеры событий) — только с закреплёнными данными.
 */
export class CallTrigger extends Block {
  static type = "call_trigger";
  static label = "Called by Flow";
  static icon = "phone-incoming";
  static category = "trigger";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [];
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return { out0: ctx.triggerData ?? { from: { flow: "flow_example" }, data: null } };
  }
}

/**
 * Выход «Запустить флоу»: в конце флоу дёргает триггер другого ОПУБЛИКОВАННОГО флоу, отдавая ему данные (`data`, по
 * умолчанию — весь вход). Не ждёт завершения вызванного флоу. Защита: флоу не может вызвать флоу из своей цепочки вызовов
 * (рекурсия, в том числе сам себя), если не включён `allowRecursive`; глубина цепочки ограничена `maxDepth` (по умолчанию 5).
 */
export class RunFlow extends Block {
  static type = "run_flow";
  static label = "Run Flow";
  static icon = "phone-outgoing";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "flowId", type: "string", required: true, picker: "flow", expressions: false },
    { name: "triggerId", type: "string", required: true, picker: "flow-trigger", expressions: false },
    // null — отдать весь вход; иначе JSON (в строках работают {{ inputs.in0.путь }})
    { name: "data", type: "json" },
    // по умолчанию флоу не может вызвать флоу из своей цепочки (в том числе себя): так он случайно не зациклится
    { name: "allowRecursive", type: "boolean", default: false },
    // предел длины цепочки вызовов (защита от бесконечной рекурсии даже при allowRecursive)
    { name: "maxDepth", type: "number", default: 5, min: 1, max: 20 },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    if (!ctx.fire) throw new Error("Calling other flows is not available in this environment");
    const flowId = String(params["flowId"] ?? "").trim();
    const triggerId = String(params["triggerId"] ?? "").trim();
    if (!flowId || !triggerId) throw new Error("Both flowId and triggerId are required");
    const data = params["data"] === undefined || params["data"] === null ? (inputs["in0"] ?? null) : params["data"];
    const allowRecursive = params["allowRecursive"] === true;
    const maxDepth = typeof params["maxDepth"] === "number" ? Math.trunc(params["maxDepth"]) : undefined;
    await ctx.fire({ flowId, triggerId, data, allowRecursive, ...(maxDepth !== undefined ? { maxDepth } : {}) });
    ctx.log(`fired trigger ${triggerId} of flow ${flowId}`);
    return { out0: { fired: true, flowId, triggerId } };
  }
}

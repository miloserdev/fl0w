import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { createJsonDriver } from "./memory";

/** Банк, в котором лежат значения счётчиков (ключ → число); каталог и песочница — те же, что у блоков памяти. */
const COUNTERS_BANK = "counters";

/**
 * Счётчик срабатываний: считает, сколько раз эта нода запускалась, и показывает число на самой ноде вместо иконки.
 * Данные проходят дальше без изменений. Счёт переживает запуски (файл на диске; у песочницы «Запустить» и рабочего
 * опубликованного флоу он свой). `name` пуст — считается именно эта нода; задан — общий счётчик с таким именем у всех
 * нод (поддерживает `{{ inputs… }}`). `operation: reset` обнуляет счёт (число на ноде становится 0).
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
    // свой счётчик у каждой ноды: ключ из флоу и id ноды; общий — по имени (префиксы не пересекаются)
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

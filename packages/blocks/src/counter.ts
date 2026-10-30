import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { createJsonDriver } from "./memory";
import { withOutputField } from "./value-io";

/** Банк, в котором лежат значения счётчиков (имя → число); каталог и песочница — те же, что у блоков памяти. */
const COUNTERS_BANK = "counters";

/**
 * Счётчик: число с именем, которое переживает запуски (хранится на диске). Каждый запуск ноды выполняет операцию:
 * `increment` / `decrement` — изменить на `step`, `reset` — вернуть `start`, `get` — только прочитать. Новый счётчик
 * начинается со `start`. Операция атомарна (в том числе между параллельными запусками). Имя поддерживает `{{ inputs… }}` —
 * счётчик на пользователя, на ключ и т.п. Результат: `{ name, value, previous }` в поле `field`.
 */
export class Counter extends Block {
  static type = "counter";
  static label = "Counter";
  static icon = "hash";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "name", type: "string", required: true, default: "counter" },
    {
      name: "operation",
      type: "enum",
      default: "increment",
      options: [{ value: "increment" }, { value: "decrement" }, { value: "reset" }, { value: "get" }],
    },
    { name: "step", type: "number", default: 1, min: 0 },
    { name: "start", type: "number", default: 0 },
    { name: "field", type: "string", default: "counter" },
    { name: "includeInput", type: "boolean", default: false },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, _ctx?: RunContext) {
    const name = String(params["name"] ?? "").trim();
    if (name === "" || name.length > 256) throw new Error("Counter name must be 1 to 256 characters");
    if (name === "__proto__") throw new Error('Counter name "__proto__" is not allowed');
    const op = String(params["operation"] ?? "increment");
    if (!["increment", "decrement", "reset", "get"].includes(op)) throw new Error(`Unknown operation "${op}"`);
    const step = Number(params["step"] ?? 1);
    const start = Number(params["start"] ?? 0);
    if (!Number.isFinite(step) || step < 0) throw new Error('"step" must be a non-negative number');
    if (!Number.isFinite(start)) throw new Error('"start" must be a number');

    const result = await createJsonDriver(COUNTERS_BANK).update((data) => {
      const known = Object.hasOwn(data, name);
      const stored = known ? data[name] : start;
      if (typeof stored !== "number" || !Number.isFinite(stored)) throw new Error(`Counter "${name}" holds a non-numeric value`);
      let value = stored;
      if (op === "increment") value = stored + step;
      else if (op === "decrement") value = stored - step;
      else if (op === "reset") value = start;
      // get не пишет в хранилище (и не создаёт счётчик) — только читает
      if (op !== "get") data[name] = value;
      return { name, value, previous: stored };
    });
    return { out0: withOutputField(inputs["in0"], params, result as Json, "counter") };
  }
}

import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";

const UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000 } as const;
/** Запуск живёт в процессе-раннере с общим лимитом 5 минут — дольше ждать бессмысленно. */
export const MAX_WAIT_MS = 5 * 60 * 1000;

/** Wait: приостанавливает ветку на заданное время и пропускает данные дальше. Прерывается отменой запуска. */
export class Wait extends Block {
  static type = "wait";
  static label = "Wait";
  static icon = "timer";
  static category = "flow";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "amount", type: "number", required: true, default: 1, min: 0 },
    {
      name: "unit",
      type: "enum",
      required: true,
      default: "seconds",
      options: [{ value: "seconds" }, { value: "minutes" }, { value: "hours" }],
    },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    const unit = String(params["unit"] ?? "seconds") as keyof typeof UNIT_MS;
    if (!(unit in UNIT_MS)) throw new Error(`Unknown unit "${unit}"`);
    const ms = Math.round(Number(params["amount"] ?? 1) * UNIT_MS[unit]);
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Wait amount must be a non-negative number");
    if (ms > MAX_WAIT_MS) throw new Error(`Wait of ${ms} ms exceeds the run limit of ${MAX_WAIT_MS} ms`);

    await new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) return reject(new Error("Aborted"));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      const timer = setTimeout(() => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    return { out0: inputs["in0"] ?? null };
  }
}

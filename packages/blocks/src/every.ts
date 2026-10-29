import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";

export const EVERY_UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000 } as const;
type EveryUnit = keyof typeof EVERY_UNIT_MS;

/**
 * Триггер «каждые N секунд/минут/часов». В опубликованном флоу срабатывает по расписанию
 * на сервере (независимо от открытой страницы); при ручном запуске — один раз сразу.
 */
export class Every extends Block {
  static type = "every";
  static label = "Every";
  static icon = "clock";
  static category = "trigger";
  static isTrigger = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "interval", type: "number", required: true, default: 1, min: 1, max: 100_000 },
    {
      name: "unit",
      type: "enum",
      required: true,
      default: "minutes",
      options: (Object.keys(EVERY_UNIT_MS) as EveryUnit[]).map((value) => ({ value })),
    },
  ];

  static intervalMs(params: Record<string, Json>): number {
    const unit = String(params["unit"] ?? "minutes");
    const interval = Number(params["interval"] ?? 1);
    if (!(unit in EVERY_UNIT_MS)) throw new Error(`Unknown unit "${unit}"`);
    if (!Number.isFinite(interval) || interval <= 0) throw new Error("Interval must be positive");
    return Math.round(interval * EVERY_UNIT_MS[unit as EveryUnit]);
  }

  async run() {
    return { out0: { triggeredAt: new Date().toISOString() } };
  }
}

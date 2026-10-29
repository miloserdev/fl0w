import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { valueOf, withOutputField } from "./value-io";

const UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 } as const;
const UNITS = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"] as const;
type Unit = (typeof UNITS)[number];
const OPERATIONS = ["now", "format", "add", "subtract", "diff", "extract", "round"] as const;
const PARTS = ["year", "month", "week", "weekday", "day", "hour", "minute", "second"] as const;

/** Разбор даты в UTC. Строки без часового пояса считаются UTC, а не локальным временем сервера. */
function parseDate(v: Json): Date {
  let d: Date;
  if (typeof v === "number") d = new Date(v);
  else if (typeof v === "string") {
    const s = v.trim();
    const noZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
    d = new Date(noZone ? `${s.replace(" ", "T")}Z` : s);
  } else d = new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${JSON.stringify(v)}`);
  return d;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function format(d: Date, fmt: string): string {
  if (fmt.trim() === "") return d.toISOString();
  return fmt.replace(/YYYY|SSS|MM|DD|HH|mm|ss/g, (t) => {
    switch (t) {
      case "YYYY": return pad(d.getUTCFullYear(), 4);
      case "MM": return pad(d.getUTCMonth() + 1);
      case "DD": return pad(d.getUTCDate());
      case "HH": return pad(d.getUTCHours());
      case "mm": return pad(d.getUTCMinutes());
      case "ss": return pad(d.getUTCSeconds());
      default: return pad(d.getUTCMilliseconds(), 3);
    }
  });
}

/** Сдвиг на месяцы с прижатием дня к концу месяца (31 января + 1 месяц = 28/29 февраля). */
function addMonths(d: Date, n: number): Date {
  const day = d.getUTCDate();
  const r = new Date(d.getTime());
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

function shift(d: Date, unit: Unit, amount: number): Date {
  if (unit === "years" || unit === "months") {
    if (!Number.isInteger(amount)) throw new Error(`Amount of ${unit} must be a whole number`);
    return addMonths(d, unit === "years" ? amount * 12 : amount);
  }
  return new Date(d.getTime() + amount * UNIT_MS[unit]);
}

/** Начало единицы (недели — с понедельника). */
function startOf(d: Date, unit: Unit): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (unit) {
    case "years": return new Date(Date.UTC(y, 0, 1));
    case "months": return new Date(Date.UTC(y, m, 1));
    case "weeks": return new Date(Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7)));
    case "days": return new Date(Date.UTC(y, m, day));
    case "hours": return new Date(Date.UTC(y, m, day, d.getUTCHours()));
    case "minutes": return new Date(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes()));
    default: return new Date(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  }
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

/** Полных единиц между датами (в сторону нуля). Для месяцев и лет — календарно. */
function between(a: Date, b: Date, unit: Unit): number {
  if (unit === "years" || unit === "months") {
    const sign = b >= a ? 1 : -1;
    const [from, to] = sign === 1 ? [a, b] : [b, a];
    let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
    if (addMonths(from, months) > to) months--;
    return sign * (unit === "years" ? Math.trunc(months / 12) : months);
  }
  return Math.trunc((b.getTime() - a.getTime()) / UNIT_MS[unit]);
}

/** Date & Time: now, format, add, subtract, diff, extract, round. Всё в UTC. */
export class DateTime extends Block {
  static type = "datetime";
  static label = "Date & Time";
  static icon = "calendar-clock";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    {
      name: "operation",
      type: "enum",
      required: true,
      default: "now",
      options: OPERATIONS.map((value) => ({ value })),
    },
    // дата: ISO-строка, мс (число) или шаблон «{{ createdAt }}»; пусто — сам вход
    { name: "value", type: "string", default: "" },
    {
      name: "unit",
      type: "enum",
      default: "days",
      options: UNITS.map((value) => ({ value })),
    },
    { name: "amount", type: "number", default: 1 },
    // токены: YYYY MM DD HH mm ss SSS; пусто — ISO 8601
    { name: "format", type: "string", default: "" },
    {
      name: "part",
      type: "enum",
      default: "year",
      options: PARTS.map((value) => ({ value })),
    },
    // вторая дата для diff (шаблон или значение)
    { name: "other", type: "string", default: "" },
    {
      name: "direction",
      type: "enum",
      default: "down",
      options: [{ value: "down" }, { value: "up" }],
    },
    { name: "field", type: "string", default: "date" },
    { name: "includeInput", type: "boolean", default: false },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const input = inputs["in0"];
    const op = String(params["operation"] ?? "now");
    const unit = String(params["unit"] ?? "days") as Unit;
    if (!UNITS.includes(unit)) throw new Error(`Unknown unit "${unit}"`);
    const fmt = String(params["format"] ?? "");
    const date = () => parseDate(valueOf(input, params["value"]));

    let result: Json;
    switch (op) {
      case "now":
        result = format(new Date(), fmt);
        break;
      case "format":
        result = format(date(), fmt);
        break;
      case "add":
      case "subtract": {
        const n = Number(params["amount"] ?? 1);
        if (!Number.isFinite(n)) throw new Error("Amount must be a number");
        result = format(shift(date(), unit, op === "add" ? n : -n), fmt);
        break;
      }
      case "diff": {
        const other = valueOf(input, params["other"]);
        if (params["other"] === "" || params["other"] === undefined) throw new Error('Date & Time: "other" is required for diff');
        result = between(date(), parseDate(other), unit);
        break;
      }
      case "extract": {
        const d = date();
        const part = String(params["part"] ?? "year");
        const parts: Record<string, number> = {
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1,
          week: isoWeek(d),
          weekday: d.getUTCDay() || 7,
          day: d.getUTCDate(),
          hour: d.getUTCHours(),
          minute: d.getUTCMinutes(),
          second: d.getUTCSeconds(),
        };
        if (!(part in parts)) throw new Error(`Unknown part "${part}"`);
        result = parts[part]!;
        break;
      }
      case "round": {
        const d = date();
        const down = startOf(d, unit);
        const rounded = params["direction"] === "up" && down.getTime() !== d.getTime() ? shift(down, unit, 1) : down;
        result = format(rounded, fmt);
        break;
      }
      default:
        throw new Error(`Unknown operation "${op}"`);
    }
    return { out0: withOutputField(input, params, result, "date") };
  }
}

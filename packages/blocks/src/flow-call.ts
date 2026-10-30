import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";
import { Block, type RunContext } from "./block";

/**
 * Пара вызовов — вызов одного флоу из другого по каналу `channelId` (связь строго 1:1). Сам вызов исполняется внутри запуска
 * вызывающего (как вложенный запуск вызванного флоу), поэтому в один процесс-раннер попадают оба флоу.
 */

/** Incoming call: вход вызванного флоу. Поднимается только парным outgoing call с тем же `channelId`. */
export class CallTrigger extends Block {
  static type = "call_trigger";
  static label = "Incoming Call";
  static icon = "phone-incoming";
  static category = "trigger";
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [{ name: "channelId", type: "string", required: true, expressions: false, picker: "channel-in" }];
  static isTrigger = true;
  static autoTrigger = true; // публикация флоу с одним лишь входящим телефоном допустима: он живёт ради вызовов
  static eventDriven = true;
  static callOnly = true;

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    // данные вызова; без них (не должно случаться — старт только вызовом) — пустой объект
    return { out0: ctx.triggerData ?? {} };
  }
}

const OUT_PORTS: PortsDef = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
const OUT_PORTS_AWAIT: PortsDef = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }, { id: "err", label: "error" }] };

/**
 * Outgoing call: вызывает incoming call с тем же `channelId`.
 *  - `await` (с подтверждением): ждёт вызванный флоу; `out0` — его результат (значение Result), `err` — ошибка, если он упал
 *    (порт виден только в этом режиме; если к `err` ничего не подключено, ошибка роняет ноду, чтобы не потеряться).
 *  - `shoot` (выстрелил и забыл): не ждёт; `out0` = `{ ok: true }` — факт отправки. Вызванный флоу идёт в фоне и обрывается, если
 *    запуск вызывающего закончится раньше; обрыв и падение пишутся в ленту событий, вызывающего они не касаются.
 */
export class RunFlow extends Block {
  static type = "run_flow";
  static label = "Outgoing Call";
  static icon = "phone-outgoing";
  static category = "flow";
  static ports = OUT_PORTS;
  static params: ParamSchema[] = [
    { name: "channelId", type: "string", required: true, expressions: false, picker: "channel-out" },
    { name: "mode", type: "enum", default: "await", options: [{ value: "await" }, { value: "shoot" }] },
    // null — отдать весь вход; иначе JSON (в строках работают {{ inputs.in0.путь }})
    { name: "data", type: "json" },
    // по умолчанию флоу не может вызвать флоу из своей цепочки (в том числе себя): так он случайно не зациклится
    { name: "allowRecursive", type: "boolean", default: false },
    // предел длины цепочки вложенных вызовов (вызовы идут в одном процессе, поэтому он ограничен: 1–20)
    { name: "maxDepth", type: "number", default: 5, min: 1, max: 20 },
  ];

  static override portsFor(params: Record<string, Json>): PortsDef {
    return params["mode"] === "shoot" ? OUT_PORTS : OUT_PORTS_AWAIT;
  }

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    if (!ctx.call) throw new Error("Calling other flows is not available in this environment");
    const channelId = String(params["channelId"] ?? "").trim();
    if (!channelId) throw new Error("channelId is required");
    const mode = params["mode"] === "shoot" ? "shoot" : "await";
    const data = params["data"] === undefined || params["data"] === null ? (inputs["in0"] ?? null) : params["data"];
    const maxDepth = typeof params["maxDepth"] === "number" ? Math.trunc(params["maxDepth"]) : undefined;
    const outcome = await ctx.call({ channelId, data, mode, allowRecursive: params["allowRecursive"] === true, ...(maxDepth !== undefined ? { maxDepth } : {}) });

    if (mode === "shoot") return { out0: { ok: true } };
    if (outcome.ok) return { out0: outcome.result };
    // ошибка вызванного флоу: по порту err; если он ни к чему не подключён — падение ноды (тихой потери нет)
    if (ctx.connected?.includes("err")) return { err: { message: outcome.error, channelId } };
    throw new Error(outcome.error);
  }
}

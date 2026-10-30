import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { interpolate } from "./json-path";
import { textOf } from "./value-io";

export const LOG_LEVELS = ["info", "warn", "error"] as const;

/**
 * Лог: пишет сообщение в журнал запуска и показывает его на самой ноде — чёрное окошко как терминал, в нём последние строки
 * последнего запуска. Данные проходят дальше без изменений. Пустое сообщение — весь вход как JSON; в сообщении работают
 * `{{ путь }}` из входа (и `{{ inputs.in0.путь }}`).
 */
export class Log extends Block {
  static type = "log";
  static label = "Log";
  static icon = "terminal";
  static category = "io";
  static resizable = true;
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "message", type: "string", multiline: true, default: "" },
    { name: "level", type: "enum", default: "info", options: LOG_LEVELS.map((value) => ({ value })) },
    { name: "width", type: "number", default: 360, min: 160, max: 4000 },
    { name: "height", type: "number", default: 160, min: 80, max: 4000 },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    const data = inputs["in0"] ?? null;
    const raw = typeof params["message"] === "string" ? params["message"] : "";
    const text = raw.trim() === "" ? textOf(data) : textOf(interpolate(raw, data));
    const level = String(params["level"] ?? "info");
    if (!(LOG_LEVELS as readonly string[]).includes(level)) throw new Error(`Unknown level "${level}"`);
    // строки с уровнем помечаются префиксом — по нему терминал красит их
    for (const line of text.split("\n")) ctx.log(level === "info" ? line : `[${level}] ${line}`);
    return { out0: data };
  }
}

import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { interpolate } from "./json-path";
import { textOf } from "./value-io";

export const LOG_LEVELS = ["info", "warn", "error"] as const;

/**
 * Log: writes a message into the run journal and shows it on the node itself, a black window like a terminal with the last lines
 * of the last run. Data passes on unchanged. An empty message means the whole input as JSON; in the message
 * `{{ path }}` from the input (and `{{ inputs.in0.path }}`) work.
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
    // lines with a level are marked with a prefix: the terminal colours them by it
    for (const line of text.split("\n")) ctx.log(level === "info" ? line : `[${level}] ${line}`);
    return { out0: data };
  }
}

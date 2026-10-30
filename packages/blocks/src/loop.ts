import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { getPath } from "./json-path";

/** Сколько итераций допускается за один запуск ноды (каждая — вложенный запуск тела цикла). */
export const MAX_LOOP_ITEMS = 1000;
/** Сколько итераций тела идут одновременно, не больше. */
export const MAX_LOOP_CONCURRENCY = 8;

const BASE: PortsDef = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
const WITH_ERR: PortsDef = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }, { id: "err", label: "errors" }] };

/**
 * Loop: повторение без рекурсии. Для каждого элемента списка (или N раз) вызывает тело цикла — граф с Collector на канале
 * `channelId` (в этом же флоу, в отдельном графе, или в другом) — и собирает результаты в массив, сохраняя порядок. Тело получает
 * `{ item, index, total }`. Граф цикла не может содержать Collector, который вызывается из него самого (это рекурсия — её валидатор запрещает).
 *  - `mode: items` — перебор массива из входа (по `path`, пусто — весь вход); `mode: times` — `times` повторов, `item` = номер.
 *  - `concurrency` — сколько итераций одновременно (1 — по очереди).
 *  - `onError: stop` — первая ошибка тела роняет ноду; `continue` — ошибки не мешают, результаты без упавших, а сами ошибки
 *    уходят в порт `err` (виден только в этом режиме).
 */
export class Loop extends Block {
  static type = "loop";
  static label = "Loop";
  static icon = "repeat";
  static category = "flow";
  static ports = BASE;
  static params: ParamSchema[] = [
    { name: "channelId", type: "string", required: true, expressions: false, picker: "channel-out" },
    { name: "mode", type: "enum", default: "items", options: [{ value: "items" }, { value: "times" }] },
    { name: "path", type: "string", default: "", showWhen: { param: "mode", in: ["items"] } },
    { name: "times", type: "number", default: 3, min: 1, max: MAX_LOOP_ITEMS, showWhen: { param: "mode", in: ["times"] } },
    { name: "concurrency", type: "number", default: 1, min: 1, max: MAX_LOOP_CONCURRENCY },
    { name: "onError", type: "enum", default: "stop", options: [{ value: "stop" }, { value: "continue" }] },
  ];

  static override portsFor(params: Record<string, Json>): PortsDef {
    return params["onError"] === "continue" ? WITH_ERR : BASE;
  }

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    if (!ctx.call) throw new Error("Calling other flows is not available in this environment");
    const channelId = String(params["channelId"] ?? "").trim();
    if (!channelId) throw new Error("channelId is required");
    const input = inputs["in0"] ?? null;

    let items: Json[];
    if (params["mode"] === "times") {
      const n = Math.trunc(Number(params["times"] ?? 1));
      if (!Number.isFinite(n) || n < 1 || n > MAX_LOOP_ITEMS) throw new Error(`"times" must be between 1 and ${MAX_LOOP_ITEMS}`);
      items = Array.from({ length: n }, (_, i) => i);
    } else {
      const path = typeof params["path"] === "string" ? params["path"].trim() : "";
      const list = path === "" ? input : getPath(input, path);
      if (!Array.isArray(list)) throw new Error(path === "" ? "The input must be an array to loop over" : `"${path}" is not an array in the input`);
      if (list.length > MAX_LOOP_ITEMS) throw new Error(`Too many items to loop over (${list.length}; at most ${MAX_LOOP_ITEMS})`);
      items = list;
    }
    const total = items.length;
    const keep = params["onError"] === "continue";
    const concurrency = Math.min(Math.max(Math.trunc(Number(params["concurrency"] ?? 1)) || 1, 1), MAX_LOOP_CONCURRENCY);

    const results: (Json | undefined)[] = new Array<Json | undefined>(total).fill(undefined);
    const errors: Json[] = [];
    let next = 0;
    let stopped: string | undefined;

    const worker = async () => {
      while (stopped === undefined) {
        const index = next++;
        if (index >= total) return;
        const outcome = await ctx.call!({ channelId, data: { item: items[index]!, index, total }, mode: "await" });
        if (outcome.ok) results[index] = outcome.result;
        else if (keep) {
          errors.push({ index, item: items[index]!, error: outcome.error });
          ctx.log(`item ${index} failed: ${outcome.error}`);
        } else {
          stopped = `Loop item ${index} failed: ${outcome.error}`;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, worker));
    if (stopped !== undefined) throw new Error(stopped);

    // упавшие (onError: continue) в результаты не попадают, порядок остальных сохраняется
    const out: Json[] = [];
    for (let i = 0; i < total; i++) if (results[i] !== undefined) out.push(results[i]!);
    return keep ? { out0: out, err: errors } : { out0: out };
  }
}

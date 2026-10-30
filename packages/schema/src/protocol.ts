import { z } from "zod";
import { flowSchema } from "./flow";
import { jsonSchema } from "./json";

/** web → runner */
export const runnerCommandSchema = z.object({
  cmd: z.literal("run"),
  flow: flowSchema,
  /**
   * id триггер-ноды, по которой стартует запуск: остальные триггеры пропускаются.
   * Без поля (ручной запуск) срабатывают все триггеры.
   */
  trigger: z.string().optional(),
  /** Данные срабатывания триггера (тело вебхука и т.п.): получает только нода-триггер через ctx. */
  triggerData: jsonSchema.optional(),
});
export type RunnerCommand = z.infer<typeof runnerCommandSchema>;

/** runner → web */
export const runnerEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("node:start"),
    nodeId: z.string(),
    /** Данные на входах ноды и её параметры после подстановки выражений (для отладки); большие значения усечены. */
    input: z.record(z.string(), jsonSchema).optional(),
    params: z.record(z.string(), jsonSchema).optional(),
  }),
  z.object({ event: z.literal("node:log"), nodeId: z.string(), message: z.string() }),
  z.object({
    event: z.literal("node:done"),
    nodeId: z.string(),
    output: z.record(z.string(), jsonSchema),
  }),
  z.object({ event: z.literal("node:error"), nodeId: z.string(), error: z.string() }),
  z.object({
    event: z.literal("flow:done"),
    result: jsonSchema.optional(),
    error: z.string().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/**
 * Живая лента запусков опубликованного флоу (Watch): сервер → UI.
 * `runId` связывает события одного запуска; триггер `null` — запуск без триггера.
 */
export const watchMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run:start"),
    runId: z.string(),
    flowId: z.string(),
    trigger: z.string().nullable(),
    /** Ноды, участвующие в запуске (ветка от триггера); нет — запуск затрагивает весь флоу. */
    nodes: z.array(z.string()).optional(),
    at: z.string(),
  }),
  z.object({ type: z.literal("run:event"), runId: z.string(), event: runnerEventSchema }),
  z.object({
    type: z.literal("run:skip"),
    flowId: z.string(),
    trigger: z.string(),
    at: z.string(),
    reason: z.enum(["busy"]),
  }),
]);
export type WatchMessage = z.infer<typeof watchMessageSchema>;

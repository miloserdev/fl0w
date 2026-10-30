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
  /** Перезапуск с ноды: исполняется она и всё после неё, остальным нужным нодам выдаются `seeds` (данные прошлого запуска). */
  from: z.string().optional(),
  seeds: z.record(z.string(), z.record(z.string(), jsonSchema)).optional(),
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
    /** Короткая подпись, которую нода просит показать на себе вместо иконки (например, число у Counter). */
    display: z.string().max(64).optional(),
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
 * runner → web: просьба запустить триггер другого флоу (блок «Run Flow»). Это не событие запуска: хозяин проверяет
 * цель и защиту от рекурсии и отвечает `FireReply`. Запуск fire-and-forget — ответ приходит, как только цель принята.
 */
export const fireRequestSchema = z.object({
  event: z.literal("fire"),
  id: z.string(),
  flowId: z.string(),
  triggerId: z.string(),
  data: jsonSchema,
  /** Разрешить вызов флоу, уже стоящего в цепочке вызовов (в том числе самого себя); глубину по-прежнему ограничивает `maxDepth`. */
  allowRecursive: z.boolean().optional(),
  /** Предел длины цепочки вызовов; по умолчанию 5, не больше 20; 0 — без ограничения. */
  maxDepth: z.number().int().min(0).optional(),
});
export type FireRequest = z.infer<typeof fireRequestSchema>;
/** web → runner: ответ на `fire`; `error` — причина отказа (цель не опубликована, рекурсия, занято…). */
export type FireReply = { cmd: "fire:result"; id: string; error?: string };

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

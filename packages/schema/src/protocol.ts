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
  /** Закрепления (pin data) действуют, даже когда задан `trigger` (запуск одного триггера из песочницы). Плановые запуски без флага. */
  pins: z.boolean().optional(),
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
  /**
   * Нода (outgoing call в режиме shoot) оборвана: вызванный флоу не успел завершиться, пока вызывающий дошёл до конца, и был
   * остановлен. Вызывающему это не сообщается — но в ленте видно.
   */
  z.object({ event: z.literal("node:killed"), nodeId: z.string(), reason: z.string() }),
  z.object({
    event: z.literal("flow:done"),
    result: jsonSchema.optional(),
    error: z.string().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/**
 * runner → web: раннер просит найти флоу с входящим телефоном (incoming call) на канале `channelId` и прислать его определение.
 * Вызванный флоу исполняется В ТОМ ЖЕ процессе, что и вызывающий (как вложенный запуск), поэтому раннеру нужен сам флоу.
 */
export const callResolveRequestSchema = z.object({
  event: z.literal("call:resolve"),
  id: z.string(),
  channelId: z.string(),
});
export type CallResolveRequest = z.infer<typeof callResolveRequestSchema>;
/** web → runner: ответ на `call:resolve` — флоу и id его incoming call либо причина отказа (нет такого канала, неоднозначно…). */
export type CallResolveReply = { cmd: "call:resolved"; id: string; flow?: unknown; triggerId?: string; error?: string };

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

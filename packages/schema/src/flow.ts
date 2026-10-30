import { z } from "zod";
import { jsonSchema } from "./json";
import { portsDefSchema } from "./block-meta";

export const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  params: z.record(z.string(), jsonSchema),
  portsOverride: portsDefSchema.nullable(),
  cssOverride: z.string().nullable(),
  /**
   * Закреплённый выход ноды (pin data): `{ порт: JSON }`. В ручном запуске нода не исполняется, а отдаёт эти данные —
   * так отлаживают цепочку без повторных вызовов и без ожидания события. В плановых запусках опубликованного флоу не действует.
   */
  pinData: z.record(z.string(), jsonSchema).nullable().optional(),
  /**
   * Нода отключена: в запуске не участвует (не исполняется, ничего не отдаёт — ветка за ней не идёт), триггер не регистрируется
   * в планировщике (таймер, вебхук, опрос), параметры не проверяются, к каналам вызова она не относится.
   */
  disabled: z.boolean().optional(),
});
export type FlowNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourcePort: z.string().min(1),
  target: z.string().min(1),
  targetPort: z.string().min(1),
});
export type FlowEdge = z.infer<typeof edgeSchema>;

/** draft — только редактируется; published — исполняется сервером по расписанию триггеров. */
export const flowStatusSchema = z.enum(["draft", "published"]);
export type FlowStatus = z.infer<typeof flowStatusSchema>;

export const flowSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  /** Нет поля = draft. Хранится только в серверной копии флоу. */
  status: flowStatusSchema.optional(),
});
export type Flow = z.infer<typeof flowSchema>;

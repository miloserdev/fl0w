import { z } from "zod";
import { jsonSchema } from "./json";

/**
 * Вид порта: `data` — обычный порт данных; `tool` и `memory` — порты подключения «ресурсов» (инструментов и памяти) к
 * ноде-хозяину, как sub-nodes у AI Agent в n8n. Соединяются только порты одного вида. Рёбра ресурсов не участвуют в потоке
 * данных (порядок, ожидание входов, циклы): хозяин получает ресурсы в `ctx` при запуске.
 */
export const PORT_KINDS = ["data", "tool", "memory"] as const;
export const portKindSchema = z.enum(PORT_KINDS);
export type PortKind = z.infer<typeof portKindSchema>;

export const portDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  /** Нет поля = data. */
  kind: portKindSchema.optional(),
  /** Порт принимает несколько рёбер (инструменты); у остальных — одно. */
  multiple: z.boolean().optional(),
});
export type PortDef = z.infer<typeof portDefSchema>;

export const portsDefSchema = z.object({
  inputs: z.array(portDefSchema),
  outputs: z.array(portDefSchema),
});
export type PortsDef = z.infer<typeof portsDefSchema>;

const paramBase = {
  name: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  default: jsonSchema.optional(),
  /**
   * false — движок НЕ подставляет в значение выражения `{{ inputs… }}` (код пользователя, скрипт Shell:
   * там `{{` — часть языка, а подстановка в скрипт была бы внедрением команд). По умолчанию подставляет.
   */
  expressions: z.boolean().optional(),
  /** Подсказка редактору: подсказки из серверных данных — каналы call-пар: "channel-in" (для входящего: занятые) / "channel-out" (для исходящего: доступные входящие). */
  picker: z.enum(["channel-in", "channel-out"]).optional(),
  /** "code" — параметр редактируется во вкладке кода (Monaco, JS), а не в авто-форме. */
  editor: z.literal("code").optional(),
  /**
   * Условная видимость (как displayOptions в n8n): параметр показывается и проверяется, только когда значение
   * другого параметра (`param`) — одно из `in`. Скрытый параметр не требуется и не валидируется.
   */
  showWhen: z.object({ param: z.string().min(1), in: z.array(z.string()).min(1) }).optional(),
};

export const paramSchemaSchema = z.discriminatedUnion("type", [
  // multiline — многострочное поле (скрипты, шаблоны); иначе однострочное
  z.object({ ...paramBase, type: z.literal("string"), multiline: z.boolean().optional() }),
  z.object({
    ...paramBase,
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ ...paramBase, type: z.literal("boolean") }),
  z.object({
    ...paramBase,
    type: z.literal("enum"),
    options: z.array(z.object({ value: z.string(), label: z.string().optional() })).min(1),
  }),
  // выбор нескольких значений из списка (галочки); значение — массив строк
  z.object({
    ...paramBase,
    type: z.literal("multienum"),
    options: z.array(z.object({ value: z.string(), label: z.string().optional() })).min(1),
  }),
  z.object({ ...paramBase, type: z.literal("json") }),
]);
export type ParamSchema = z.infer<typeof paramSchemaSchema>;

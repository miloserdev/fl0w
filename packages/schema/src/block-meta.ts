import { z } from "zod";
import { jsonSchema } from "./json";

export const portDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
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
  /** "code" — параметр редактируется во вкладке кода (Monaco, JS), а не в авто-форме. */
  editor: z.literal("code").optional(),
};

export const paramSchemaSchema = z.discriminatedUnion("type", [
  z.object({ ...paramBase, type: z.literal("string") }),
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
  z.object({ ...paramBase, type: z.literal("json") }),
]);
export type ParamSchema = z.infer<typeof paramSchemaSchema>;

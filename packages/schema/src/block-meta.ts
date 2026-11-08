import { z } from "zod";
import { jsonSchema } from "./json";

/**
  * Port kind: `data` is a regular data port; `tool` and `memory` are ports that attach "resources" (tools and memory) to
  * the host node, like the sub-nodes of AI Agent in n8n. Only ports of the same kind connect. Resource edges do not take part in the data
  * flow (order, input waiting, cycles): the host receives the resources in `ctx` at run time.
 */
export const PORT_KINDS = ["data", "tool", "memory"] as const;
export const portKindSchema = z.enum(PORT_KINDS);
export type PortKind = z.infer<typeof portKindSchema>;

export const portDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  /** No field = data. */
  kind: portKindSchema.optional(),
  /** The port accepts several edges (tools); the others accept one. */
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
   * false: the engine does NOT substitute `{{ inputs… }}` expressions into the value (user code, Shell script:
   * there `{{` is part of the language, and substituting into a script would be command injection). Substitutes by default.
   */
  expressions: z.boolean().optional(),
  /** Hint for the editor: hints from server data, the call-pair channels: "channel-in" (for incoming: busy ones) / "channel-out" (for outgoing: available incoming ones). */
  picker: z.enum(["channel-in", "channel-out"]).optional(),
  /** "code": the parameter is edited in the code tab (Monaco, JS) rather than in the auto-form. */
  editor: z.literal("code").optional(),
  /**
   * Conditional visibility (like displayOptions in n8n): the parameter is shown and validated only when the value
   * of another parameter (`param`) is one of `in`. A hidden parameter is not required and not validated.
   */
  showWhen: z.object({ param: z.string().min(1), in: z.array(z.string()).min(1) }).optional(),
};

export const paramSchemaSchema = z.discriminatedUnion("type", [
  // multiline: multi-line field (scripts, templates); otherwise single-line
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
  // choosing several values from a list (checkboxes); the value is an array of strings
  z.object({
    ...paramBase,
    type: z.literal("multienum"),
    options: z.array(z.object({ value: z.string(), label: z.string().optional() })).min(1),
  }),
  z.object({ ...paramBase, type: z.literal("json") }),
]);
export type ParamSchema = z.infer<typeof paramSchemaSchema>;

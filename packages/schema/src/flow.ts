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
   * Pinned node output (pin data): `{ port: JSON }`. In a manual run the node is not executed and returns this data instead,
   * which is how a chain is debugged without repeated calls and without waiting for an event. Has no effect in scheduled runs of a published flow.
   */
  pinData: z.record(z.string(), jsonSchema).nullable().optional(),
  /**
   * The node is disabled: it takes no part in the run (not executed, outputs nothing, so the branch behind it does not run), its trigger is not registered
   * in the scheduler (timer, webhook, poll), parameters are not validated, and it does not belong to call channels.
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

/** draft: only edited; published: executed by the server on the triggers' schedule. */
export const flowStatusSchema = z.enum(["draft", "published"]);
export type FlowStatus = z.infer<typeof flowStatusSchema>;

export const flowSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  /** No field = draft. Stored only in the server-side copy of the flow. */
  status: flowStatusSchema.optional(),
});
export type Flow = z.infer<typeof flowSchema>;

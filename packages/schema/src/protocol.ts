import { z } from "zod";
import { flowSchema } from "./flow";
import { jsonSchema } from "./json";

/** web → runner */
export const runnerCommandSchema = z.object({
  cmd: z.literal("run"),
  flow: flowSchema,
  /**
   * id of the trigger node that starts the run: the other triggers are skipped.
   * Without the field (manual run) all triggers fire.
   */
  trigger: z.string().optional(),
  /** Trigger firing data (webhook body, etc.): received only by the trigger node via ctx. */
  triggerData: jsonSchema.optional(),
  /** Restart from a node: it and everything after it are executed; the other needed nodes are given `seeds` (data from the previous run). */
  /** Pins (pin data) apply even when `trigger` is set (running a single trigger from the sandbox). Scheduled runs without the flag. */
  pins: z.boolean().optional(),
  from: z.string().optional(),
  seeds: z.record(z.string(), z.record(z.string(), jsonSchema)).optional(),
});
export type RunnerCommand = z.infer<typeof runnerCommandSchema>;
/** web → runner: control of a running run. */
export type RunnerControl = { cmd: "pause" | "resume" };

/** runner → web */
export const runnerEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("node:start"),
    nodeId: z.string(),
    /** Data at the node's inputs and its parameters after expression substitution (for debugging); large values are truncated. */
    input: z.record(z.string(), jsonSchema).optional(),
    params: z.record(z.string(), jsonSchema).optional(),
  }),
  z.object({ event: z.literal("node:log"), nodeId: z.string(), message: z.string() }),
  z.object({
    event: z.literal("node:done"),
    nodeId: z.string(),
    /** A short label the node asks to show on itself instead of the icon (for example, the number on Counter). */
    display: z.string().max(64).optional(),
    output: z.record(z.string(), jsonSchema),
  }),
  z.object({ event: z.literal("node:error"), nodeId: z.string(), error: z.string() }),
  /**
   * The node (outgoing call in shoot mode) was cut off: the called flow had not finished by the time the caller reached the end, and was
   * stopped. The caller is not told about this, but it is visible in the feed.
   */
  z.object({ event: z.literal("node:killed"), nodeId: z.string(), reason: z.string() }),
  /** The run was paused / resumed: new nodes do not start, running ones finish. */
  z.object({ event: z.literal("run:paused"), paused: z.boolean() }),
  z.object({
    event: z.literal("flow:done"),
    result: jsonSchema.optional(),
    error: z.string().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/**
 * runner → web: the runner asks to find the flow with an incoming call (incoming phone) on channel `channelId` and send its definition.
 * The called flow runs IN THE SAME process as the caller (as a nested run), so the runner needs the flow itself.
 */
export const callResolveRequestSchema = z.object({
  event: z.literal("call:resolve"),
  id: z.string(),
  channelId: z.string(),
});
export type CallResolveRequest = z.infer<typeof callResolveRequestSchema>;
/** web → runner: reply to `call:resolve`: the flow and the id of its incoming call, or the reason for refusal (no such channel, ambiguous…). */
export type CallResolveReply = { cmd: "call:resolved"; id: string; flow?: unknown; triggerId?: string; error?: string };

/**
 * Live feed of runs of a published flow (Watch): server → UI.
 * `runId` ties together the events of one run; trigger `null` means a run without a trigger.
 */
export const watchMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run:start"),
    runId: z.string(),
    flowId: z.string(),
    trigger: z.string().nullable(),
    /** Nodes taking part in the run (the branch from the trigger); absent: the run affects the whole flow. */
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

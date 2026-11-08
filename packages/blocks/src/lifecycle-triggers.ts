import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type LifecycleSpec, type RunContext } from "./block";

const payload = (ctx: RunContext, who: string): Json => triggerPayload(ctx, who);

/**
 * Activation Trigger: fires on lifecycle events of THIS flow: publication, update
 * of an already published flow, server start (or restart). Output: { event, at, flow: {id, name} }.
 */
export class ActivationTrigger extends Block {
  static type = "activation_trigger";
  static label = "Activation Trigger";
  static icon = "power";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "onPublish", type: "boolean", default: true },
    { name: "onUpdate", type: "boolean", default: true },
    { name: "onStartup", type: "boolean", default: true },
  ];

  static lifecycle(params: Record<string, Json>): LifecycleSpec {
    return {
      publish: params["onPublish"] !== false,
      update: params["onUpdate"] !== false,
      startup: params["onStartup"] !== false,
    };
  }

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return { out0: payload(ctx, "Activation Trigger") };
  }
}

/**
 * Workflow Trigger: as in n8n (a deprecated node, kept for compatibility): publication and update
 * of a published flow, without server start. For all three events use Activation Trigger.
 */
export class WorkflowTrigger extends Block {
  static type = "workflow_trigger";
  static label = "Workflow Trigger";
  static icon = "workflow";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "onPublish", type: "boolean", default: true },
    { name: "onUpdate", type: "boolean", default: true },
  ];

  static lifecycle(params: Record<string, Json>): LifecycleSpec {
    return { publish: params["onPublish"] !== false, update: params["onUpdate"] !== false, startup: false };
  }

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return { out0: payload(ctx, "Workflow Trigger") };
  }
}

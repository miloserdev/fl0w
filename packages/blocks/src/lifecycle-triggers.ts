import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type LifecycleSpec, type RunContext } from "./block";

const sample = (ctx: RunContext): Json =>
  ctx.triggerData ?? { event: "publish", at: new Date().toISOString(), flow: { id: "flow_example", name: "example" } };

/**
 * Activation Trigger: срабатывает на события жизненного цикла ЭТОГО флоу — публикация, обновление
 * уже опубликованного флоу, старт (или перезапуск) сервера. Выход: { event, at, flow: {id, name} }.
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
    return { out0: sample(ctx) };
  }
}

/**
 * Workflow Trigger: как в n8n (устаревшая нода, сохранена для совместимости) — публикация и обновление
 * опубликованного флоу, без старта сервера. Для всех трёх событий используйте Activation Trigger.
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
    return { out0: sample(ctx) };
  }
}

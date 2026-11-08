import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type RunContext } from "./block";
import { stringList } from "./list-utils";

/**
 * Error Trigger: starts this flow (an "error handler") when an automatic run of another
 * published flow fails (on a schedule, webhook, file, activation). Manual runs from the editor
 * do not get here. A failure of the handler itself does not start new handlers: there is no chain of errors.
 * Output: { flow: {id, name}, run: {id, trigger}, error: {message, node}, at }.
 */
export class ErrorTrigger extends Block {
  static type = "error_trigger";
  static label = "Error Trigger";
  static icon = "octagon-alert";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  // ids of flows whose errors to handle; empty means errors of any flow (including this one)
  static params: ParamSchema[] = [{ name: "flows", type: "json", default: [] }];

  static errorScope(params: Record<string, Json>) {
    return { flows: stringList(params["flows"], "flows") };
  }

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return { out0: triggerPayload(ctx, "Error Trigger") };
  }
}

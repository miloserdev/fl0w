import { Block } from "./block";

/** Manual Trigger: the starting point of a manual run. Does not fire on a schedule or incoming requests. */
export class ManualTrigger extends Block {
  static type = "manual";
  static label = "Manual Trigger";
  static icon = "mouse-pointer-click";
  static category = "trigger";
  static isTrigger = true;
  static manualStart = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params = [];

  async run() {
    return { out0: { triggeredAt: new Date().toISOString() } };
  }
}

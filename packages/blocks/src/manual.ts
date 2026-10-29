import { Block } from "./block";

/** Manual Trigger: точка старта при ручном запуске. По расписанию и входящим запросам не срабатывает. */
export class ManualTrigger extends Block {
  static type = "manual";
  static label = "Manual Trigger";
  static icon = "mouse-pointer-click";
  static category = "trigger";
  static isTrigger = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params = [];

  async run() {
    return { out0: { triggeredAt: new Date().toISOString() } };
  }
}

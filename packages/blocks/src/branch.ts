import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { conditionParams, evalCondition } from "./conditions";
import { getPath } from "./json-path";

/** Один вход → два выхода: `true` получает данные, если условие выполнено, иначе `false`. */
export class Branch extends Block {
  static type = "branch";
  static label = "Branch";
  static icon = "git-fork";
  static category = "flow";
  static ports = {
    inputs: [{ id: "in0" }],
    outputs: [
      { id: "out0", label: "true" },
      { id: "out1", label: "false" },
    ],
  };
  static params: ParamSchema[] = conditionParams();

  async run(inputs: Record<string, Json>, params: Record<string, Json>): Promise<Record<string, Json>> {
    const data = inputs["in0"] ?? null;
    const passed = evalCondition(
      getPath(data, String(params["field"] ?? "")),
      String(params["operator"] ?? "truthy"),
      params["value"],
    );
    // непройденная ветка остаётся без ключа — по ней данные не идут (SPEC §5.5)
    return passed ? { out0: data } : { out1: data };
  }
}

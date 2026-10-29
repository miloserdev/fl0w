import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { stringList } from "./list-utils";

/**
 * Error Trigger: запускает этот флоу («обработчик ошибок»), когда падает автоматический запуск
 * другого опубликованного флоу (по расписанию, вебхуку, файлу, активации). Ручные запуски из редактора
 * сюда не попадают. Падение самого обработчика новых обработчиков не вызывает — цепочки ошибок нет.
 * Выход: { flow: {id, name}, run: {id, trigger}, error: {message, node}, at }.
 */
export class ErrorTrigger extends Block {
  static type = "error_trigger";
  static label = "Error Trigger";
  static icon = "octagon-alert";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  // id флоу, чьи ошибки обрабатывать; пусто — ошибки любых флоу (включая этот)
  static params: ParamSchema[] = [{ name: "flows", type: "json", default: [] }];

  static errorScope(params: Record<string, Json>) {
    return { flows: stringList(params["flows"], "flows") };
  }

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return {
      out0: ctx.triggerData ?? {
        flow: { id: "flow_example", name: "example" },
        run: { id: "run_example", trigger: "trigger" },
        error: { message: "Example error", node: "node" },
        at: new Date().toISOString(),
      },
    };
  }
}

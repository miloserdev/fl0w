import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type FileWatchSpec, type RunContext } from "./block";
import { assertRelativePath } from "./sandbox";

/**
 * Local File Trigger: срабатывает при добавлении, изменении или удалении файла в каталоге файлов
 * (`FL0W_FILES_DIR`) — за указанным файлом или в указанной папке. Работает у опубликованного флоу.
 * Выход: { event, path, name, size, modifiedAt } (для удалённого файла — без size и modifiedAt).
 */
export class LocalFileTrigger extends Block {
  static type = "local_file_trigger";
  static label = "Local File Trigger";
  static icon = "folder-search";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    // файл или папка относительно каталога файлов; пусто — сам каталог
    { name: "path", type: "string", default: "" },
    {
      name: "event",
      type: "enum",
      default: "any",
      options: [{ value: "any" }, { value: "add" }, { value: "change" }, { value: "unlink" }],
    },
    // маска имени файла: * и ?
    { name: "pattern", type: "string", default: "*" },
    { name: "recursive", type: "boolean", default: false },
  ];

  static fileWatch(params: Record<string, Json>): FileWatchSpec {
    const path = String(params["path"] ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    assertRelativePath(path);
    const event = String(params["event"] ?? "any");
    if (!["any", "add", "change", "unlink"].includes(event)) throw new Error(`Unknown event "${event}"`);
    return {
      path,
      event: event as FileWatchSpec["event"],
      pattern: String(params["pattern"] || "*"),
      recursive: params["recursive"] === true,
    };
  }

  async run(_inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext) {
    return {
      out0: ctx.triggerData ?? {
        event: "add",
        path: `${String(params["path"] ?? "").replace(/\/+$/, "")}/example.txt`.replace(/^\//, ""),
        name: "example.txt",
        size: 0,
        modifiedAt: new Date().toISOString(),
      },
    };
  }
}

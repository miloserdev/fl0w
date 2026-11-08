import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type FileWatchSpec, type RunContext } from "./block";
import { assertRelativePath } from "./sandbox";

/**
 * Local File Trigger: fires when a file is added, changed or deleted in the files directory
 * (`FL0W_FILES_DIR`), for the given file or in the given folder. Works for a published flow.
 * Output: { event, path, name, size, modifiedAt } (for a deleted file, without size and modifiedAt).
 */
export class LocalFileTrigger extends Block {
  static type = "local_file_trigger";
  static label = "Local File Trigger";
  static icon = "folder-search";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    // file or folder relative to the files directory; empty means the directory itself
    { name: "path", type: "string", default: "" },
    {
      name: "event",
      type: "enum",
      default: "any",
      options: [{ value: "any" }, { value: "add" }, { value: "change" }, { value: "unlink" }],
    },
    // file name mask: * and ?
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
    return { out0: triggerPayload(ctx, "Local File Trigger") };
  }
}

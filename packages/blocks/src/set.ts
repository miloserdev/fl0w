import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { cloneJson, deletePath, isPlainObject, resolveTemplates, setPath } from "./json-path";
import { stringList } from "./list-utils";

/**
 * Edit Fields (Set): задаёт, перезаписывает и удаляет поля. Значения — JSON; строки с `{{ путь }}`
 * подставляют данные самого объекта (вместо выражений n8n). Массив объектов обрабатывается поэлементно.
 */
export class SetFields extends Block {
  static type = "set";
  static label = "Edit Fields";
  static icon = "pencil";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    // { "поле.вложенное": значение | "{{ путь }}" }
    { name: "fields", type: "json", default: {} },
    { name: "keepOnlySet", type: "boolean", default: false },
    // пути, которые нужно удалить из результата
    { name: "remove", type: "json", default: [] },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>) {
    const fields = params["fields"] ?? {};
    if (!isPlainObject(fields)) throw new Error('Parameter "fields" must be an object of { path: value }');
    const remove = stringList(params["remove"], "remove");
    const keepOnly = params["keepOnlySet"] === true;

    const edit = (item: Json): Json => {
      if (!keepOnly && !isPlainObject(item)) {
        throw new Error("Edit Fields expects an object or an array of objects");
      }
      const out: { [key: string]: Json } = keepOnly ? {} : cloneJson(item as { [key: string]: Json });
      for (const [path, value] of Object.entries(fields)) setPath(out, path, resolveTemplates(value, item));
      for (const path of remove) deletePath(out, path);
      return out;
    };

    const input = inputs["in0"] ?? null;
    return { out0: Array.isArray(input) ? input.map(edit) : edit(input) };
  }
}

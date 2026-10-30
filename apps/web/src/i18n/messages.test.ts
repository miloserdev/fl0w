import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { registry } from "@fl0w/blocks";
import type { FlowIssueCode } from "@fl0w/engine";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import { locales } from "./config";

type Tree = { [k: string]: Tree | string };
const dict: Record<string, Tree> = { en, ru };

function keys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === "string" ? [prefix + k] : keys(v, `${prefix}${k}.`),
  );
}
const has = (tree: Tree, path: string) =>
  path.split(".").reduce<Tree | string | undefined>((t, k) => (typeof t === "object" ? t[k] : undefined), tree) !== undefined;

// компилятор требует перечислить ВСЕ коды ошибок валидации — новый код без записи не соберётся
const issueCodes = Object.keys({
  schema: 1,
  duplicate_node: 1,
  duplicate_edge: 1,
  unknown_type: 1,
  unknown_node: 1,
  unknown_port: 1,
  port_occupied: 1,
  port_kind: 1,
  call_channel: 1,
  call_same_graph: 1,
  cycle: 1,
  param_required: 1,
  param_type: 1,
  param_enum: 1,
  param_range: 1,
} satisfies Record<FlowIssueCode, 1>);

describe("словари", () => {
  it("языки из конфига — ровно те, для которых есть словарь", () => {
    expect([...locales].sort()).toEqual(Object.keys(dict).sort());
  });

  it("ru и en содержат одинаковые ключи", () => {
    expect(keys(ru).sort()).toEqual(keys(en).sort());
  });

  it.each(Object.keys(dict))("%s: все сообщения — валидный ICU (скобки экранируются кавычками)", (lang) => {
    const tree = dict[lang]!;
    for (const k of keys(tree)) {
      const v = k.split(".").reduce<Tree | string>((t, p) => (t as Tree)[p]!, tree) as string;
      expect(() => new IntlMessageFormat(v, lang), `${lang}:${k}`).not.toThrow();
    }
  });

  it("нет пустых строк", () => {
    for (const [lang, tree] of Object.entries(dict)) {
      for (const k of keys(tree)) {
        const v = k.split(".").reduce<Tree | string>((t, p) => (t as Tree)[p]!, tree);
        expect(v, `${lang}:${k}`).not.toBe("");
      }
    }
  });

  it.each(Object.keys(dict))("%s: есть перевод для каждого кода ошибки валидации", (lang) => {
    for (const code of issueCodes) expect(has(dict[lang]!, `issues.${code}`), `${lang}: issues.${code}`).toBe(true);
  });

  it.each(Object.keys(dict))("%s: каждый блок реестра локализован (имя, категория, параметры, опции)", (lang) => {
    const d = dict[lang]!;
    for (const [type, cls] of Object.entries(registry)) {
      expect(has(d, `blocks.${type}`), `${lang}: blocks.${type}`).toBe(true);
      expect(has(d, `categories.${cls.category}`), `${lang}: categories.${cls.category}`).toBe(true);
      for (const port of [...cls.ports.inputs, ...cls.ports.outputs]) {
        if (port.label) expect(has(d, `ports.${type}.${port.id}`), `${lang}: ports.${type}.${port.id}`).toBe(true);
      }
      for (const p of cls.params) {
        if (p.editor === "code") continue; // правится во вкладке кода, подписи нет
        expect(has(d, `params.${type}.${p.name}`), `${lang}: params.${type}.${p.name}`).toBe(true);
        if (p.type === "enum") {
          for (const o of p.options) {
            expect(has(d, `paramOptions.${p.name}.${o.value}`) || o.label !== undefined, `${lang}: paramOptions.${p.name}.${o.value}`).toBe(true);
          }
        }
      }
    }
  });
});

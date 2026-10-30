// Чистая логика выражений `{{ … }}` для форм параметров: режим выражения, разбор на сегменты для подсветки,
// вставка шаблона в позицию курсора. Без зависимостей от React — покрыто тестами.

export type Segment = {
  text: string;
  /** text — обычный текст; inputs — `{{ inputs.… }}` (данные входа); relative — `{{ путь }}` (блок разрешает сам);
   *  open — набираемое, ещё не закрытое `{{ …` */
  kind: "text" | "inputs" | "relative" | "open";
};

const TEMPLATE = /\{\{[^{}]*\}\}/;
const SPLIT = /(\{\{[^{}]*\}\}|\{\{[^{}]*$)/;

/** Есть ли в значении полное выражение `{{ … }}` (то же правило, что `hasExpression` из @fl0w/blocks). */
export function hasTemplate(v: unknown): boolean {
  return typeof v === "string" && TEMPLATE.test(v);
}

export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  for (const part of text.split(SPLIT)) {
    if (part === "") continue;
    if (!part.startsWith("{{")) out.push({ text: part, kind: "text" });
    else if (!part.endsWith("}}")) out.push({ text: part, kind: "open" });
    else out.push({ text: part, kind: /^\{\{\s*inputs(\.|\s*\}\})/.test(part) ? "inputs" : "relative" });
  }
  return out;
}

/** Находится ли позиция внутри строкового литерала JSON (нечётное число неэкранированных кавычек левее). */
export function insideJsonString(text: string, pos: number): boolean {
  let inside = false;
  for (let i = 0; i < pos && i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && inside) i++;
    else if (c === '"') inside = !inside;
  }
  return inside;
}

export const INPUT_TEMPLATE = "{{ inputs.in0. }}";

/** Вставляет шаблон в позицию выделения; каретка — перед ` }}` (сразу после `in0.`). */
export function insertTemplate(
  text: string,
  start: number,
  end: number,
  opts: { json?: boolean } = {},
): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const quote = opts.json && !insideJsonString(text, s);
  const snippet = quote ? `"${INPUT_TEMPLATE}"` : INPUT_TEMPLATE;
  const caret = s + snippet.length - (quote ? 4 : 3);
  return { text: text.slice(0, s) + snippet + text.slice(e), caret };
}

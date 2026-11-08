// Pure logic of `{{ … }}` expressions for parameter forms: expression mode, splitting into segments for highlighting,
// inserting a template at the cursor position. No React dependencies — covered by tests.

export type Segment = {
  text: string;
  /** text — plain text; inputs — `{{ inputs.… }}` (input data); relative — `{{ path }}` (the block resolves it itself);
   *  open — being typed, not closed yet `{{ …` */
  kind: "text" | "inputs" | "relative" | "open";
};

const TEMPLATE = /\{\{[^{}]*\}\}/;
const SPLIT = /(\{\{[^{}]*\}\}|\{\{[^{}]*$)/;

/** Whether the value contains a full `{{ … }}` expression (the same rule as `hasExpression` from @fl0w/blocks). */
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

/** Whether the position is inside a JSON string literal (an odd number of unescaped quotes to the left). */
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

/** Inserts a template at the selection position; the caret goes before ` }}` (right after `in0.`). */
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

/**
 * Scoped CSS for nodes.
 *
 * User CSS is not inserted as is: first `sanitizeCss` splits it into
 * top-level items (strings, comments and brackets are accounted for), drops
 * forbidden at-rules and stray `}` and guarantees balance. Then
 * `scopeCss` wraps the result in `[data-node-id="…"] { … }` — native CSS nesting:
 * all selectors automatically become descendants of the node container, `&` is the container itself.
 */

// at-rules that are safe inside a scope. The others (@import, @font-face, @keyframes,
// @property, @namespace, …) create global entities — we drop them.
const ALLOWED_AT_RULES = new Set(["media", "supports", "container", "layer"]);

type Item = { text: string; kind: "block" | "statement" };

function atRuleName(text: string): string | null {
  const m = /^@([\w-]+)/.exec(text.trimStart());
  return m ? m[1]!.toLowerCase() : null;
}

function splitTopLevel(css: string): Item[] {
  const items: Item[] = [];
  let buf = "";
  let depth = 0;
  let parens = 0;
  let quote: string | null = null;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;

    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < css.length) buf += css[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      buf += " ";
      continue;
    }
    if (ch === "\\" && i + 1 < css.length) {
      buf += ch + css[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")" && parens > 0) parens--;

    if (ch === "{") {
      depth++;
      buf += ch;
    } else if (ch === "}") {
      if (depth === 0) {
        // a stray closing brace is an attempt to "jump out" of the scope, ignore it
        buf = "";
        continue;
      }
      depth--;
      buf += ch;
      if (depth === 0) {
        items.push({ text: buf.trim(), kind: "block" });
        buf = "";
      }
    } else if (ch === ";" && depth === 0 && parens === 0) {
      buf += ch;
      items.push({ text: buf.trim(), kind: "statement" });
      buf = "";
    } else {
      buf += ch;
    }
  }
  // an unclosed block/tail without `;` at the end — dropped (for example, while typing in the editor)
  return items;
}

export function sanitizeCss(css: string): string {
  return splitTopLevel(css)
    .filter((item) => {
      if (!item.text || item.text === ";") return false;
      const name = atRuleName(item.text);
      return name === null || ALLOWED_AT_RULES.has(name);
    })
    .map((item) => item.text)
    .join("\n")
    .replace(/<\/(style)/gi, "<\\/$1");
}

function attrValue(id: string): string {
  return id.replace(/[\\"\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}

export function scopeCss(css: string, nodeId: string): string {
  const safe = sanitizeCss(css);
  if (!safe) return "";
  return `[data-node-id="${attrValue(nodeId)}"] {\n${safe}\n}`;
}

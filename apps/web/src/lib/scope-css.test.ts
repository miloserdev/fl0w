import { describe, expect, it } from "vitest";
import { sanitizeCss, scopeCss } from "./scope-css";

describe("scopeCss", () => {
  it("wraps CSS in the node container", () => {
    expect(scopeCss(".a { color: red }", "n1")).toBe(
      '[data-node-id="n1"] {\n.a { color: red }\n}',
    );
  });

  it("empty CSS yields no rules", () => {
    expect(scopeCss("  /* только комментарий */ ", "n1")).toBe("");
  });

  it("does not let a stray closing brace escape the scope", () => {
    const out = scopeCss(".a{color:red} } body{background:red} .b{", "n1");
    expect(out).toContain(".a{color:red}");
    expect(out).toContain("body{background:red}");
    // body stays inside the wrapper: exactly one top-level pair of braces
    expect(out.startsWith('[data-node-id="n1"] {')).toBe(true);
    expect(out.endsWith("\n}")).toBe(true);
    const depthAtEnd = [...out].reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
    expect(depthAtEnd).toBe(0);
    expect(out).not.toContain(".b{");
  });

  it("a global injection via `}` at the start does not pass", () => {
    const out = scopeCss("} html { display: none } {", "n1");
    expect(out.indexOf("html")).toBeGreaterThan(out.indexOf("{"));
  });

  it("braces inside strings and url() do not break parsing", () => {
    const css = '.a::after { content: "}{;" } .b { background: url(data:image/png;base64,AAA) }';
    const out = sanitizeCss(css);
    expect(out).toContain('content: "}{;"');
    expect(out).toContain("url(data:image/png;base64,AAA)");
  });

  it("drops at-rules that create global entities", () => {
    const css = [
      '@import url("https://evil.test/x.css");',
      "@font-face { font-family: X; src: url(x.woff) }",
      "@keyframes spin { to { opacity: 0 } }",
      "@property --x { syntax: '*'; inherits: false }",
      "@media (min-width: 1px) { .a { color: red } }",
    ].join("\n");
    const out = sanitizeCss(css);
    expect(out).not.toMatch(/@import|@font-face|@keyframes|@property/);
    expect(out).toContain("@media (min-width: 1px)");
  });

  it("allows declarations and & at the top level", () => {
    const out = scopeCss("background: tomato; & .x { color: red }", "n1");
    expect(out).toContain("background: tomato;");
    expect(out).toContain("& .x { color: red }");
  });

  it("does not allow closing the style tag", () => {
    expect(sanitizeCss('.a { content: "</style><script>" }')).not.toMatch(/<\/style/i);
  });

  it("escapes the node id in the attribute", () => {
    const out = scopeCss(".a{}", 'x"] body [y="');
    expect(out.split("\n")[0]).not.toContain('"] body');
  });
});

import { describe, expect, it } from "vitest";
import { hasTemplate, insertTemplate, insideJsonString, splitSegments } from "./expression-segments";

describe("hasTemplate", () => {
  it("finds full templates and ignores non-strings and unclosed ones", () => {
    expect(hasTemplate("{{ inputs.in0.x }}")).toBe(true);
    expect(hasTemplate("a {{ x }} b")).toBe(true);
    expect(hasTemplate("{{ inputs.in0.")).toBe(false);
    expect(hasTemplate(5)).toBe(false);
    expect(hasTemplate(undefined)).toBe(false);
    expect(hasTemplate("")).toBe(false);
  });
});

describe("splitSegments", () => {
  it("splits text and joins back without loss", () => {
    const src = "Привет, {{ inputs.in0.name }}! ({{ id }}) {{ inputs.in0.";
    const segs = splitSegments(src);
    expect(segs.map((s) => s.text).join("")).toBe(src);
    expect(segs.map((s) => s.kind)).toEqual(["text", "inputs", "text", "relative", "text", "open"]);
  });
  it("empty string and a string without templates", () => {
    expect(splitSegments("")).toEqual([]);
    expect(splitSegments("abc")).toEqual([{ text: "abc", kind: "text" }]);
  });
  it("inputs without a path and spaces", () => {
    expect(splitSegments("{{inputs}}")[0]?.kind).toBe("inputs");
    expect(splitSegments("{{inputsX.a}}")[0]?.kind).toBe("relative");
  });
  it("line breaks are preserved", () => {
    const src = "a\n{{ x }}\nb";
    expect(splitSegments(src).map((s) => s.text).join("")).toBe(src);
  });
});

describe("insideJsonString", () => {
  it("handles quotes and escaping", () => {
    expect(insideJsonString('{"a": "', 7)).toBe(true);
    expect(insideJsonString('{"a": 1', 7)).toBe(false);
    expect(insideJsonString('"a\\"b', 5)).toBe(true);
  });
});

describe("insertTemplate", () => {
  it("inserts at the position and puts the caret after in0.", () => {
    const r = insertTemplate("abcd", 2, 2);
    expect(r.text).toBe("ab{{ inputs.in0. }}cd");
    expect(r.text.slice(r.caret)).toBe(" }}cd");
  });
  it("replaces the selection", () => {
    expect(insertTemplate("abcd", 1, 3).text).toBe("a{{ inputs.in0. }}d");
  });
  it("json: outside a string — in quotes, inside — without", () => {
    const a = insertTemplate('{"a": }', 6, 6, { json: true });
    expect(a.text).toBe('{"a": "{{ inputs.in0. }}"}');
    expect(a.text.slice(a.caret)).toBe(' }}"}');
    const b = insertTemplate('{"a": "x"}', 8, 8, { json: true });
    expect(b.text).toBe('{"a": "x{{ inputs.in0. }}"}');
  });
  it("out-of-range bounds", () => {
    expect(insertTemplate("ab", 10, 20).text).toBe("ab{{ inputs.in0. }}");
  });
});

describe("JSON with expressions", () => {
  it("template strings inside JSON are parsed as ordinary strings and recognized", () => {
    const v = JSON.parse('{"a": "{{ inputs.in0.x }}", "b": ["{{ id }}"]}');
    expect(hasTemplate(v.a)).toBe(true);
    expect(JSON.parse('"{{ inputs.in0.x }}"')).toBe("{{ inputs.in0.x }}");
    expect(hasTemplate(JSON.stringify(v))).toBe(true);
    const r = insertTemplate('{"a": }', 6, 6, { json: true });
    expect(() => JSON.parse(r.text)).not.toThrow();
  });
});

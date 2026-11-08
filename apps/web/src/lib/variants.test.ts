import { describe, expect, it } from "vitest";
import { cva, type VariantProps } from "./variants";

const v = cva("base", {
  variants: { tone: { a: "tone-a", b: "tone-b" }, size: { sm: "s-sm", lg: "s-lg" } },
  defaultVariants: { tone: "a", size: "sm" },
});

describe("cva", () => {
  it("joins the base, the default variants and the extra className", () => {
    expect(v()).toBe("base tone-a s-sm");
    expect(v({ className: "x" })).toBe("base tone-a s-sm x");
  });
  it("lets the caller choose variants; null falls back to nothing, undefined to the default", () => {
    expect(v({ tone: "b", size: "lg" })).toBe("base tone-b s-lg");
    expect(v({ tone: null })).toBe("base s-sm");
    expect(v({ tone: undefined })).toBe("base tone-a s-sm");
  });
  it("ignores unknown values and exposes typed props", () => {
    const props: VariantProps<typeof v> = { tone: "a" };
    expect(v({ ...props, size: "nope" as "sm" })).toBe("base tone-a");
  });
});

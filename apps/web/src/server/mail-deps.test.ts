import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Mail polling (Mail Trigger) runs in the Next server process itself, and the libraries are loaded dynamically and hidden from the bundler:
 * Node looks for them starting from the application directory, not from the blocks package. So they must be dependencies of apps/web
 * (otherwise the log says: "Cannot find package 'imapflow'" and no mail arrives).
 */
describe("mail libraries are visible to the application server", () => {
  const require = createRequire(import.meta.url);
  it.each(["imapflow", "nodemailer", "mailparser"])("%s", (name) => {
    expect(() => require.resolve(name)).not.toThrow();
  });
});

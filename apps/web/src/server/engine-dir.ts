import { createRequire } from "node:module";
import path from "node:path";

/** Directory of the engine package — the cwd of the child process, from which it takes tsx and the runner sources. */
export function engineDir(): string {
  const req = createRequire(path.join(/* turbopackIgnore: true */ process.cwd(), "package.json"));
  return path.dirname(req.resolve("@fl0w/engine/package.json"));
}

import { createRequire } from "node:module";
import path from "node:path";

/** Каталог пакета engine — cwd дочернего процесса, откуда он берёт tsx и исходники раннера. */
export function engineDir(): string {
  const req = createRequire(path.join(/* turbopackIgnore: true */ process.cwd(), "package.json"));
  return path.dirname(req.resolve("@fl0w/engine/package.json"));
}

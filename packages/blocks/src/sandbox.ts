/**
 * Доступ к файлам только внутри одного каталога (`FL0W_FILES_DIR`). Node-only: модули подключаются
 * динамически внутри функций (SPEC §3). Защита от выхода: абсолютные пути, `..`, NUL-байты и
 * символические ссылки, ведущие наружу.
 */
export const FILES_DIR_ENV = "FL0W_FILES_DIR";

/** Каталог файлов (создаётся при необходимости), с раскрытыми симлинками. */
export async function filesBaseDir(): Promise<string> {
  const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
  const dir = process.env[FILES_DIR_ENV];
  if (!dir) throw new Error(`File access is not configured: set ${FILES_DIR_ENV}`);
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

/** Проверка относительного пути без обращения к диску (годится и для проверки параметров). */
export function assertRelativePath(rel: string): void {
  if (rel.includes("\0")) throw new Error("Path contains a NUL byte");
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\")) {
    throw new Error(`Path "${rel}" must be relative to the files directory`);
  }
  if (rel.split(/[\\/]/).includes("..")) throw new Error(`Path "${rel}" must not contain ".."`);
}

/**
 * Абсолютный путь к `rel` строго внутри `base` (`base` — результат `filesBaseDir`).
 * Для несуществующих файлов проверяется ближайший существующий предок: символическая ссылка,
 * ведущая за пределы каталога, отвергается.
 */
export async function resolveInside(base: string, rel: string): Promise<string> {
  const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
  const path = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:path");
  assertRelativePath(rel);
  const target = path.resolve(base, rel);
  const inside = (p: string) => p === base || p.startsWith(base + path.sep);
  if (!inside(target)) throw new Error(`Path "${rel}" is outside the files directory`);

  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!inside(real)) throw new Error(`Path "${rel}" leads outside the files directory`);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}

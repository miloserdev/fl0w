import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { globBase, globToRegExp, hasGlob } from "./glob";
import { resolveTemplates } from "./json-path";
import { mapLimit } from "./list-utils";
import { filesBaseDir, resolveInside } from "./sandbox";
import { textOf, valueOf } from "./value-io";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_GLOB_FILES = 1000;
const MAX_WALK_ENTRIES = 20_000;
/** Предел суммарного размера файлов за одно чтение по маске и числа одновременно открытых файлов / запросов `lstat`. */
const MAX_TOTAL_READ_BYTES = 50 * 1024 * 1024;
const FS_CONCURRENCY = 16;

type FileInfo = { path: string; name: string; type: "file" | "dir"; size: number; modifiedAt: string };

/**
 * Read/Write Files: чтение, запись, дописывание и список файлов в каталоге файлов (`FL0W_FILES_DIR`) —
 * выше него доступа нет (SPEC §12). Путь поддерживает `{{ шаблоны }}`. Чтение по маске (`*`, `?`, `[abc]`,
 * `**`) отдаёт список. Бинарные данные — через формат base64.
 */
export class Files extends Block {
  static type = "files";
  static label = "Read/Write Files";
  static icon = "file-text";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    {
      name: "operation",
      type: "enum",
      required: true,
      default: "read",
      options: [{ value: "read" }, { value: "write" }, { value: "append" }, { value: "list" }],
    },
    // путь относительно каталога файлов; для read и list допустима маска
    { name: "path", type: "string", required: true },
    {
      name: "format",
      type: "enum",
      default: "text",
      options: [{ value: "text" }, { value: "json" }, { value: "base64" }],
    },
    // write/append: что записать; пусто — вход
    { name: "content", type: "json", default: null },
    { name: "createDirs", type: "boolean", default: true },
    { name: "overwrite", type: "boolean", default: true },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx?: RunContext) {
    const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
    const nodePath = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:path");
    const input = inputs["in0"];
    const op = String(params["operation"] ?? "read");
    const format = String(params["format"] ?? "text");
    if (!["text", "json", "base64"].includes(format)) throw new Error(`Unknown format "${format}"`);
    const base = await filesBaseDir();
    // пустой путь остаётся пустым (корень каталога файлов): общее правило valueOf «пусто — взять вход» тут неуместно
    const rawPath = String(params["path"] ?? "");
    const rel = (rawPath === "" ? "" : textOf(valueOf(input, rawPath))).replace(/\\/g, "/").replace(/^\.\//, "");
    if (rel === "" && op !== "list") throw new Error('Files: "path" is required');

    // отмена запуска: проверяется между операциями с диском, а чтение/запись получают сам signal
    const signal = ctx?.signal;
    const alive = () => {
      if (signal?.aborted) throw new Error("Aborted");
    };
    const toRel = (abs: string) => nodePath.relative(base, abs).split(nodePath.sep).join("/");
    const info = async (abs: string): Promise<FileInfo> => {
      alive();
      const st = await fs.lstat(abs);
      return {
        path: toRel(abs),
        name: nodePath.basename(abs),
        type: st.isDirectory() ? "dir" : "file",
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      };
    };

    /** Обход каталога без перехода по симлинкам; возвращает пути, подходящие под маску. */
    const matching = async (glob: string, wantDirs: boolean): Promise<string[]> => {
      const start = await resolveInside(base, globBase(glob));
      const re = globToRegExp(glob);
      const found: string[] = [];
      let seen = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          alive();
          if (++seen > MAX_WALK_ENTRIES) throw new Error("Files: too many entries to scan, narrow the pattern");
          const abs = nodePath.join(dir, e.name);
          const isDir = e.isDirectory();
          if (re.test(toRel(abs)) && (isDir ? wantDirs : e.isFile())) found.push(abs);
          if (isDir) await walk(abs);
        }
      };
      await walk(start);
      return found.sort();
    };

    if (op === "list") {
      if (hasGlob(rel)) return { out0: await mapLimit(await matching(rel, true), FS_CONCURRENCY, info) };
      const dir = await resolveInside(base, rel);
      const entries = await fs.readdir(dir);
      if (entries.length > MAX_WALK_ENTRIES) throw new Error(`Files: the directory has too many entries (${entries.length}; at most ${MAX_WALK_ENTRIES}) — narrow it with a pattern`);
      return { out0: await mapLimit(entries.sort(), FS_CONCURRENCY, (n) => info(nodePath.join(dir, n))) };
    }

    if (op === "read") {
      const readOne = async (abs: string) => {
        const meta = await info(abs);
        if (meta.type !== "file") throw new Error(`Files: "${meta.path}" is not a file`);
        if (meta.size > MAX_FILE_BYTES) throw new Error(`Files: "${meta.path}" is larger than ${MAX_FILE_BYTES} bytes`);
        const bytes = await fs.readFile(abs, { signal });
        let content: Json;
        if (format === "base64") content = bytes.toString("base64");
        else if (format === "json") {
          try {
            content = JSON.parse(bytes.toString("utf8")) as Json;
          } catch (e) {
            throw new Error(`Files: "${meta.path}" is not valid JSON`, { cause: e });
          }
        } else content = bytes.toString("utf8");
        return { ...meta, content };
      };
      if (hasGlob(rel)) {
        const paths = (await matching(rel, false)).slice(0, MAX_GLOB_FILES);
        // суммарный размер проверяем ДО чтения (по метаданным), чтобы не набрать гигабайты в память
        const sizes = await mapLimit(paths, FS_CONCURRENCY, async (p) => (await info(p)).size);
        const total = sizes.reduce<number>((a, b) => a + (typeof b === "number" ? b : 0), 0);
        if (total > MAX_TOTAL_READ_BYTES) throw new Error(`Files: the matching files are ${total} bytes in total (at most ${MAX_TOTAL_READ_BYTES}) — narrow the pattern`);
        return { out0: await mapLimit(paths, FS_CONCURRENCY, readOne) };
      }
      const abs = await resolveInside(base, rel);
      try {
        return { out0: await readOne(abs) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Files: "${rel}" does not exist`, { cause: e });
        throw e;
      }
    }

    if (op !== "write" && op !== "append") throw new Error(`Unknown operation "${op}"`);
    if (hasGlob(rel)) throw new Error("Files: a pattern cannot be used to write");
    const abs = await resolveInside(base, rel);

    const raw = params["content"] === null || params["content"] === undefined ? (input ?? null) : resolveTemplates(params["content"], input);
    let bytes: Buffer;
    if (format === "base64") {
      if (typeof raw !== "string") throw new Error("Files: base64 content must be a string");
      bytes = Buffer.from(raw, "base64");
    } else if (format === "json") bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    else bytes = Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw), "utf8");
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`Files: content is larger than ${MAX_FILE_BYTES} bytes`);

    if (params["createDirs"] !== false) await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    if (op === "write") {
      const exists = await fs.lstat(abs).then(() => true, () => false);
      if (exists && params["overwrite"] === false) throw new Error(`Files: "${rel}" already exists`);
      // через временный файл: читатель не увидит наполовину записанный результат
      const tmp = `${abs}.${process.pid}.tmp`;
      alive();
      await fs.writeFile(tmp, bytes, { signal });
      await fs.rename(tmp, abs);
    } else {
      alive();
      await fs.appendFile(abs, bytes);
    }
    const meta = await info(abs);
    return { out0: { path: meta.path, name: meta.name, size: meta.size, bytesWritten: bytes.length } };
  }
}

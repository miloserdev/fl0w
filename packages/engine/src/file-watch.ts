/** Node-only: file watching for the Local File Trigger. Exported via `@fl0w/engine/server`. */
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { globToRegExp, resolveInside, type FileWatchSpec } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import type { FileWatchFactory } from "./scheduler";

export type FileWatcherOptions = {
  /** Files directory (`FL0W_FILES_DIR`); watching above it is not allowed. */
  baseDir: string;
  /** A burst of events for one file (create + several writes) is collapsed into one trigger. */
  debounceMs?: number;
  log?: (msg: string) => void;
};

const MAX_SCAN_ENTRIES = 20_000;

/**
  * `fs.watch` only reports "something happened to X", so the event type is derived from the file state:
  * no known entry → add; signature (mtime:size) changed → change; file gone but known → unlink.
  * Files that already exist at start are considered known and produce no events.
 */
export function createFileWatcher(opts: FileWatcherOptions): FileWatchFactory {
  const debounceMs = opts.debounceMs ?? 100;
  const log = opts.log ?? (() => {});

  return (spec: FileWatchSpec, onChange: (payload: Json) => void) => {
    let stopped = false;
    let watcher: FSWatcher | undefined;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const start = async () => {
      await mkdir(opts.baseDir, { recursive: true });
      const base = await realpath(opts.baseDir);
      const target = await resolveInside(base, spec.path);
      const st = await lstat(target).catch(() => null);
      if (!st) return void log(`file watch: "${spec.path}" does not exist, not watching`);
      const isFile = st.isFile();
      const watchDir = isFile ? path.dirname(target) : target;
      const onlyName = isFile ? path.basename(target) : null;
      const nameMatches = globToRegExp(spec.pattern);
      const recursive = spec.recursive && !isFile;
      const toKey = (abs: string) => path.relative(base, abs).split(path.sep).join("/");

      const known = new Map<string, string>(); // relative path → "mtimeMs:size"
      let scanned = 0;
      const scan = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (++scanned > MAX_SCAN_ENTRIES) return;
          const abs = path.join(dir, e.name);
          if (e.isDirectory() && recursive) await scan(abs);
          else if (e.isFile()) {
            const s = await lstat(abs);
            known.set(toKey(abs), `${s.mtimeMs}:${s.size}`);
          }
        }
      };
      await scan(watchDir);
      if (stopped) return;

      const emit = (event: "add" | "change" | "unlink", key: string, info?: { size: number; mtime: Date }) => {
        if (spec.event !== "any" && spec.event !== event) return;
        onChange({
          event,
          path: key,
          name: path.basename(key),
          ...(info ? { size: info.size, modifiedAt: info.mtime.toISOString() } : {}),
        });
      };

      const classify = async (rel: string) => {
        if (stopped) return;
        const name = path.basename(rel);
        if (onlyName !== null ? name !== onlyName : !nameMatches.test(name)) return;
        const abs = path.join(watchDir, rel);
        const key = toKey(abs);
        const s = await lstat(abs).catch(() => null);
        if (stopped) return;
        if (!s) {
          if (known.delete(key)) emit("unlink", key);
          return;
        }
        if (!s.isFile()) return; // directories and symlinks are not watched
        const sig = `${s.mtimeMs}:${s.size}`;
        const prev = known.get(key);
        known.set(key, sig);
        if (prev === undefined) emit("add", key, s);
        else if (prev !== sig) emit("change", key, s);
      };

      watcher = watch(watchDir, { recursive }, (_event, filename) => {
        if (stopped || !filename) return;
        const rel = String(filename).split(path.sep).join("/");
        clearTimeout(timers.get(rel));
        timers.set(
          rel,
          setTimeout(() => {
            timers.delete(rel);
            void classify(rel).catch((e) => log(`file watch: ${e instanceof Error ? e.message : String(e)}`));
          }, debounceMs),
        );
      });
      watcher.on("error", (e) => log(`file watch error: ${e.message}`));
    };

    start().catch((e) => log(`file watch not started: ${e instanceof Error ? e.message : String(e)}`));

    return () => {
      stopped = true;
      watcher?.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  };
}

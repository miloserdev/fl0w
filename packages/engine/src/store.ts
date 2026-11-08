/** Node-only. Server-side flow storage: one JSON file per flow. */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { flowSchema, type Flow } from "@fl0w/schema";

/** The id ends up in a file name, so only safe characters are allowed (no `..` or `/`). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isSafeFlowId = (id: string): boolean => SAFE_ID.test(id);

export class FlowStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!isSafeFlowId(id)) throw new Error(`Unsafe flow id "${id}"`);
    return path.join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<Flow | null> {
    if (!isSafeFlowId(id)) return null;
    try {
      return flowSchema.parse(JSON.parse(await readFile(this.file(id), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  /** Writes are atomic: to a temp file, then rename, so a restart mid-write cannot leave a corrupt flow. */
  async put(flow: Flow): Promise<void> {
    const file = this.file(flow.id);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(flow, null, 2));
    await rename(tmp, file);
  }

  /** All readable flows; corrupt files are skipped (reported through onCorrupt). */
  async list(onCorrupt?: (file: string, error: unknown) => void): Promise<Flow[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const flows: Flow[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      try {
        flows.push(flowSchema.parse(JSON.parse(await readFile(path.join(this.dir, name), "utf8"))));
      } catch (e) {
        onCorrupt?.(name, e);
      }
    }
    return flows;
  }
}

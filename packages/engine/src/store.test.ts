import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edge, flow, node } from "./test-helpers";
import { FlowStore, isSafeFlowId } from "./store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = (id: string, status?: "draft" | "published") => ({
  ...flow([node("s", "source", { json: 1 }), node("r", "result")], [edge("s", "r")]),
  id,
  ...(status ? { status } : {}),
});

describe("FlowStore", () => {
  it("put → get возвращает тот же флоу вместе со статусом", async () => {
    const store = new FlowStore(dir);
    await store.put(sample("flow_a", "published"));
    expect(await store.get("flow_a")).toEqual(sample("flow_a", "published"));
  });

  it("создаёт каталог при первой записи; несуществующий флоу → null", async () => {
    const store = new FlowStore(path.join(dir, "nested", "deeper"));
    expect(await store.get("nope")).toBeNull();
    await store.put(sample("flow_a"));
    expect(await store.get("flow_a")).not.toBeNull();
  });

  it("put перезаписывает без временных файлов", async () => {
    const store = new FlowStore(dir);
    await store.put(sample("flow_a", "draft"));
    await store.put(sample("flow_a", "published"));
    expect((await store.get("flow_a"))?.status).toBe("published");
    expect(readdirSync(dir)).toEqual(["flow_a.json"]);
  });

  it("list отдаёт все флоу, пропуская битые и сообщая о них", async () => {
    const store = new FlowStore(dir);
    await store.put(sample("flow_b"));
    await store.put(sample("flow_a"));
    writeFileSync(path.join(dir, "broken.json"), "{not json");
    writeFileSync(path.join(dir, "wrong.json"), JSON.stringify({ version: 9 }));
    writeFileSync(path.join(dir, "readme.txt"), "ignored");
    const corrupt: string[] = [];
    const list = await store.list((file) => corrupt.push(file));
    expect(list.map((f) => f.id)).toEqual(["flow_a", "flow_b"]);
    expect(corrupt.sort()).toEqual(["broken.json", "wrong.json"]);
  });

  it("list пустого/отсутствующего каталога → []", async () => {
    expect(await new FlowStore(path.join(dir, "missing")).list()).toEqual([]);
  });

  it("небезопасные id отвергаются (path traversal)", async () => {
    const store = new FlowStore(dir);
    for (const id of ["../evil", "a/b", "a\\b", "", ".", "..", "x".repeat(65), "a b"]) {
      expect(isSafeFlowId(id), id).toBe(false);
      expect(await store.get(id)).toBeNull();
      await expect(store.put(sample(id))).rejects.toThrow(/Unsafe flow id/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("безопасные id", () => {
    for (const id of ["flow_abc123", "a", "A-b_9"]) expect(isSafeFlowId(id)).toBe(true);
  });
});

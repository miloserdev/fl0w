import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Counter } from "./counter";
import { Crypto } from "./crypto";
import { Files } from "./files";
import { MEMORY_DIR_ENV, MemoryBank } from "./memory";
import { FILES_DIR_ENV } from "./sandbox";
import { CodeTool } from "./tools";

let dir: string;
let saved: { files?: string; memory?: string };
beforeAll(() => {
  saved = { files: process.env[FILES_DIR_ENV], memory: process.env[MEMORY_DIR_ENV] };
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-abort-"));
  process.env[FILES_DIR_ENV] = path.join(dir, "files");
  process.env[MEMORY_DIR_ENV] = path.join(dir, "memory");
});
afterAll(() => {
  for (const [k, v] of [[FILES_DIR_ENV, saved.files], [MEMORY_DIR_ENV, saved.memory]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const aborted = () => {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
};
const ctx = (signal: AbortSignal) => ({ signal, log() {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("отмена запуска доходит до блоков, которые раньше её не слушали", () => {
  it("Files: уже отменённый запуск не пишет и не читает", async () => {
    const files = new Files();
    await expect(files.run({ in0: {} }, { operation: "write", path: "a.txt", content: "x", format: "text" }, ctx(aborted()))).rejects.toThrow("Aborted");
    expect(existsSync(path.join(dir, "files", "a.txt"))).toBe(false);
    writeFileSync(path.join(dir, "files", "b.txt"), "ok");
    await expect(files.run({ in0: {} }, { operation: "read", path: "b.txt", format: "text" }, ctx(aborted()))).rejects.toThrow("Aborted");
    // без отмены работает как раньше
    expect(await files.run({ in0: {} }, { operation: "read", path: "b.txt", format: "text" }, ctx(new AbortController().signal))).toMatchObject({ out0: { content: "ok" } });
  });

  it("Memory Bank и Counter: ожидание занятого замка прекращается по отмене (раньше — до 10 с)", async () => {
    const memDir = process.env[MEMORY_DIR_ENV]!;
    // «чужой» свежий замок: ждать пришлось бы до LOCK_WAIT_MS
    mkdirSync(memDir, { recursive: true });
    for (const bank of ["held", "counters"]) {
      writeFileSync(path.join(memDir, `${bank}.json.lock`), "");
    }
    for (const attempt of [
      async (signal: AbortSignal) => new MemoryBank().createMemory({ driver: "json", name: "held" }, signal).set("k", 1),
      async (signal: AbortSignal) => void (await new Counter().run({ in0: 1 }, { name: "x" }, ctx(signal))),
    ]) {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const t0 = Date.now();
      await expect(attempt(ac.signal)).rejects.toThrow("Aborted");
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });

  it("Memory Bank: уже отменённый запуск не читает и не пишет; без отмены работает", async () => {
    const bank = new MemoryBank();
    await expect(bank.createMemory({ driver: "json", name: "fresh" }, aborted()).get("k")).rejects.toThrow("Aborted");
    await expect(bank.createMemory({ driver: "json", name: "fresh" }, aborted()).set("k", 1)).rejects.toThrow("Aborted");
    const live = bank.createMemory({ driver: "json", name: "fresh" }, new AbortController().signal);
    await live.set("k", 2);
    expect(await live.get("k")).toBe(2);
  });

  it("Code Tool: отмена хозяина останавливает код инструмента сразу, а не по его таймауту", async () => {
    const tool = new CodeTool().createTool({ name: "hang", code: "await new Promise(() => {}); return { out0: 1 }", timeoutMs: 20_000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    await expect(tool.call(null, ac.signal)).rejects.toThrow(/Aborted/);
    expect(Date.now() - t0).toBeLessThan(3000);
    await expect(tool.call(null, aborted())).rejects.toThrow("Aborted");
  });

  it("Crypto: вывод ключа не блокирует цикл событий и учитывает отмену; шифрование по-прежнему обратимо", async () => {
    const crypto = new Crypto();
    await expect(crypto.run({ in0: "x" }, { action: "encrypt", value: "secret text", secret: "pw" }, ctx(aborted()))).rejects.toThrow("Aborted");
    const enc = (await crypto.run({ in0: {} }, { action: "encrypt", value: "secret text", secret: "pw", field: "r" }, ctx(new AbortController().signal))) as { out0: { r: string } };
    const dec = (await crypto.run({ in0: {} }, { action: "decrypt", value: enc.out0.r, secret: "pw", field: "r" }, ctx(new AbortController().signal))) as { out0: { r: string } };
    expect(dec.out0.r).toBe("secret text");
    // пока считается scrypt, таймеры идут (раньше scryptSync замораживал цикл на время вывода ключа)
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await Promise.all(Array.from({ length: 4 }, () => crypto.run({ in0: {} }, { action: "encrypt", value: "x", secret: "pw" }, ctx(new AbortController().signal))));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    await sleep(1);
  });
});

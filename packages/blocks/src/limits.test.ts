import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { Files } from "./files";
import { HttpRequest, MAX_RESPONSE_BYTES } from "./http-request";
import { mapLimit } from "./list-utils";
import { validateParams } from "./params";
import { registry } from "./registry";
import { FILES_DIR_ENV } from "./sandbox";

const ctx = () => ({ signal: new AbortController().signal, log() {} });

describe("HTTP Request: предел размера ответа", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/small") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: 1 }));
      if (req.url === "/declared") {
        // Content-Length больше предела: ошибка до чтения тела
        res.writeHead(200, { "content-length": String(MAX_RESPONSE_BYTES + 1) });
        return void res.end("x");
      }
      // без Content-Length (chunked): поток режется по ходу чтения
      res.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, "a");
      let sent = 0;
      const write = () => {
        while (sent <= MAX_RESPONSE_BYTES + 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", write);
        }
        res.end();
      };
      write();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (p: string) => new HttpRequest().run({ in0: {} }, { method: "GET", url: `${base}${p}`, timeoutMs: 15_000 }, ctx());

  it("обычный ответ читается", async () => {
    expect(await get("/small")).toEqual({ out0: { ok: 1 } });
  });

  it("Content-Length сверх предела — ошибка сразу; бесконечный поток без Content-Length обрывается на пределе", async () => {
    await expect(get("/declared")).rejects.toThrow(/larger than 10485760 bytes/);
    await expect(get("/stream")).rejects.toThrow(/larger than 10485760 bytes/);
  });
});

describe("Files: суммарный размер и параллелизм", () => {
  let dir: string;
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[FILES_DIR_ENV];
    dir = mkdtempSync(path.join(tmpdir(), "fl0w-limits-"));
    process.env[FILES_DIR_ENV] = dir;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[FILES_DIR_ENV];
    else process.env[FILES_DIR_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("чтение по маске: суммарный размер проверяется по метаданным ДО чтения (разреженные файлы по 9 МБ × 6 > 50 МБ)", async () => {
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `big${i}.txt`);
      writeFileSync(f, "");
      truncateSync(f, 9 * 1024 * 1024);
    }
    await expect(new Files().run({ in0: {} }, { operation: "read", path: "big*.txt", format: "text" })).rejects.toThrow(/in total \(at most 52428800\)/);
  });

  it("небольшие файлы по маске читаются, список по маске и каталога работает", async () => {
    for (let i = 0; i < 3; i++) writeFileSync(path.join(dir, `s${i}.json`), JSON.stringify({ i }));
    const read = (await new Files().run({ in0: {} }, { operation: "read", path: "s*.json", format: "json" })) as unknown as { out0: { content: Json }[] };
    expect(read.out0.map((f) => f.content)).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    const list = (await new Files().run({ in0: {} }, { operation: "list", path: "s*.json" })) as unknown as { out0: unknown[] };
    expect(list.out0).toHaveLength(3);
  });
});

describe("mapLimit", () => {
  it("не больше N задач одновременно, результаты в порядке списка, ошибка отклоняет", async () => {
    let cur = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7, 8], 3, async (n) => {
      cur++;
      peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, n));
      cur--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 8, 4, 6, 12, 14, 16]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
    await expect(mapLimit([1, 2, 3], 2, async (n) => (n === 2 ? Promise.reject(new Error("x")) : n))).rejects.toThrow("x");
  });
});

describe("Code: верхняя граница таймаута", () => {
  it("timeoutMs ограничен 1…300000 у Code, Code Agent и Code Tool", () => {
    for (const t of ["code", "code_agent", "tool_code"]) {
      const params = registry[t]!.params;
      expect(validateParams(params, { timeoutMs: 300_000 }), t).toEqual([]);
      expect(validateParams(params, { timeoutMs: 300_001 }).map((i) => i.param), t).toContain("timeoutMs");
      expect(validateParams(params, { timeoutMs: 0 }).map((i) => i.param), t).toContain("timeoutMs");
    }
  });
});

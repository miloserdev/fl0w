import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Json } from "@fl0w/schema";
import type { RunContext } from "./block";
import { CodeBlock } from "./code";

const ctx = (signal = new AbortController().signal) => ({ log: vi.fn<(msg: string) => void>(), signal });

const run = (
  code: string,
  inputs: Record<string, Json> = {},
  params: Record<string, Json> = {},
  c: RunContext = ctx(),
) => new CodeBlock().run(inputs, { code, ...params }, c);

describe("CodeBlock: контракт", () => {
  it("тело функции получает inputs и params, возвращает { out0 }", async () => {
    const out = await run(
      `const d = inputs.in0; return { out0: { ...d, sum: d.a + params.k } }`,
      { in0: { a: 1 } },
      { k: 41 },
    );
    expect(out).toEqual({ out0: { a: 1, sum: 42 } });
  });

  it("params не содержит сам код", async () => {
    const out = await run(`return { out0: Object.keys(params) }`, {}, { x: 1 });
    expect(out).toEqual({ out0: ["x"] });
  });

  it("поддерживает async/await", async () => {
    expect(await run(`await Promise.resolve(); return { out0: 1 }`)).toEqual({ out0: 1 });
  });

  it("несколько выходов; undefined-значение = порт пуст", async () => {
    expect(await run(`return { out0: undefined, out1: [1, 2] }`)).toEqual({ out1: [1, 2] });
  });

  it("log уходит в ctx.log", async () => {
    const c = ctx();
    await run(`log("hi", { a: 1 }, 2); return {}`, {}, {}, c);
    expect(c.log).toHaveBeenCalledWith('hi {"a":1} 2');
  });

  it("ошибка в коде → исключение с сообщением", async () => {
    await expect(run(`throw new Error("nope")`)).rejects.toThrow("nope");
    await expect(run(`null.x`)).rejects.toThrow(/null/);
    await expect(run(`throw "plain"`)).rejects.toThrow("plain");
  });

  it("синтаксическая ошибка → исключение", async () => {
    await expect(run(`return {{{`)).rejects.toThrow(/Unexpected|SyntaxError|token/i);
  });

  it("не-объект / массив / цикл на выходе → понятная ошибка", async () => {
    await expect(run(`return 5`)).rejects.toThrow(/must return an object/);
    await expect(run(`return [1]`)).rejects.toThrow(/must return an object/);
    await expect(run(`return undefined`)).rejects.toThrow(/must return an object/);
    await expect(run(`const o = {}; o.o = o; return { out0: o }`)).rejects.toThrow(/circular/i);
  });
});

describe("CodeBlock: песочница (только env)", () => {
  const probe = async (expr: string) => (await run(`return { out0: ${expr} }`)).out0;

  it.each([
    "require",
    "process",
    "module",
    "exports",
    "fs",
    "Buffer",
    "global",
    "setTimeout",
    "setInterval",
    "console",
    "queueMicrotask",
    "structuredClone",
    "__host",
    "__dirname",
  ])("%s недоступен", async (name) => {
    expect(await probe(`typeof ${name}`)).toBe("undefined");
  });

  it("globalThis содержит только env + стандартные встроенные объекты JS", async () => {
    const own = (await probe(`Object.getOwnPropertyNames(globalThis)`)) as string[];
    for (const n of ["inputs", "params", "log", "fetch"]) expect(own).toContain(n);
    for (const n of ["process", "require", "console", "fs", "__host"]) expect(own).not.toContain(n);
  });

  it("process / require недоступны и как обращение (ReferenceError)", async () => {
    await expect(run(`return { out0: process.env }`)).rejects.toThrow(/process is not defined/);
    await expect(run(`return { out0: require("fs") }`)).rejects.toThrow(/require is not defined/);
    await expect(run(`return { out0: (await import("node:fs")) }`)).rejects.toThrow();
  });

  it("выход через constructor.constructor не даёт доступа к хосту", async () => {
    const escape = (from: string) =>
      probe(`(() => { try { return ${from}.constructor.constructor("return typeof process")() } catch (e) { return "blocked" } })()`);
    for (const from of ["inputs", "params", "log", "fetch", "globalThis", "this", "(async () => {})", "({})", "Object.getPrototypeOf(globalThis)"]) {
      expect(["undefined", "blocked"]).toContain(await escape(from));
    }
  });

  it("Function / eval работают только в контексте кода", async () => {
    expect(await probe(`Function("return typeof process")()`)).toBe("undefined");
    expect(await probe(`eval("typeof process")`)).toBe("undefined");
    expect(await probe(`Function("return typeof require")()`)).toBe("undefined");
  });

  it("ошибка сети внутри кода — объект контекста, а не хостовая ошибка", async () => {
    const out = await run(`
      try { await fetch("http://127.0.0.1:1/") } catch (e) {
        return { out0: [e.constructor.name, e.constructor.constructor("return typeof process")()] }
      }`);
    expect(out["out0"]).toEqual(["TypeError", "undefined"]);
  });

  it("входные данные — копия: код не меняет объекты хоста", async () => {
    const data = { a: [1] };
    await run(`inputs.in0.a.push(2); return {}`, { in0: data });
    expect(data).toEqual({ a: [1] });
  });
});

describe("CodeBlock: таймаут и отмена", () => {
  it("бесконечный синхронный цикл обрывается по таймауту", async () => {
    const t = Date.now();
    await expect(run(`while (true) {}`, {}, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("зависшее ожидание обрывается по таймауту", async () => {
    await expect(run(`await new Promise(() => {})`, {}, { timeoutMs: 100 })).rejects.toThrow(
      "Code timed out after 100 ms",
    );
  });

  it("отмена по ctx.signal", async () => {
    const ac = new AbortController();
    const p = run(`await new Promise(() => {})`, {}, {}, ctx(ac.signal));
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow("Aborted");
  });

  it("уже отменённый signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run(`return {}`, {}, {}, ctx(ac.signal))).rejects.toThrow("Aborted");
  });
});

describe("CodeBlock: fetch", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/missing") {
          res.writeHead(404, { "x-test": "yes" }).end('{"error":"nf"}');
        } else if (req.url === "/hang") {
          // не отвечаем
        } else {
          res
            .writeHead(200, { "content-type": "application/json", "X-Echo": "hello" })
            .end(JSON.stringify({ method: req.method, url: req.url, body, ct: req.headers["content-type"] ?? null }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("GET → json()", async () => {
    const out = await run(`const r = await fetch(params.base + "/x?q=1"); return { out0: await r.json() }`, {}, { base });
    expect(out["out0"]).toMatchObject({ method: "GET", url: "/x?q=1" });
  });

  it("POST с телом и заголовками", async () => {
    const out = await run(
      `const r = await fetch(params.base, { method: "POST", headers: { "Content-Type": "text/x" }, body: JSON.stringify({ a: 1 }) });
       return { out0: await r.json() }`,
      {},
      { base },
    );
    expect(out["out0"]).toMatchObject({ method: "POST", body: '{"a":1}', ct: "text/x" });
  });

  it("ok / status / headers.get / text()", async () => {
    const out = await run(
      `const r = await fetch(params.base + "/missing");
       return { out0: { ok: r.ok, status: r.status, h: r.headers.get("X-Test"), none: r.headers.get("nope"), t: await r.text() } }`,
      {},
      { base },
    );
    expect(out["out0"]).toEqual({ ok: false, status: 404, h: "yes", none: null, t: '{"error":"nf"}' });
  });

  it("запрос обрывается вместе с таймаутом блока", async () => {
    const t = Date.now();
    await expect(
      run(`await fetch(params.base + "/hang")`, {}, { base, timeoutMs: 150 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

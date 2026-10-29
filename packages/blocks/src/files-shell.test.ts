import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { ActivationTrigger, WorkflowTrigger } from "./lifecycle-triggers";
import type { Block, RunContext } from "./block";
import { ErrorTrigger } from "./error-trigger";
import { Files } from "./files";
import { globBase, globToRegExp, hasGlob } from "./glob";
import { LocalFileTrigger } from "./local-file-trigger";
import { resolveParams } from "./params";
import { registry } from "./registry";
import { FILES_DIR_ENV, assertRelativePath, filesBaseDir, resolveInside } from "./sandbox";
import { SHELL_ALLOW_ENV, Shell } from "./shell";

type Cls = { new (): Block; params: import("@fl0w/schema").ParamSchema[] };
const run = (cls: Cls, input: Json | undefined, params: Record<string, Json> = {}, ctx: Partial<RunContext> = {}) =>
  new cls().run(input === undefined ? {} : { in0: input }, resolveParams(cls.params, params), {
    log() {},
    signal: new AbortController().signal,
    ...ctx,
  });
const out0 = async (...a: Parameters<typeof run>) => (await run(...a))["out0"];

let dir: string;
let outside: string;
let base: string;
const saved = { files: process.env[FILES_DIR_ENV], shell: process.env[SHELL_ALLOW_ENV] };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-files-"));
  outside = mkdtempSync(path.join(tmpdir(), "fl0w-outside-"));
  base = realpathSync(dir);
  process.env[FILES_DIR_ENV] = dir;
  process.env[SHELL_ALLOW_ENV] = "1";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  for (const [k, v] of [[FILES_DIR_ENV, saved.files], [SHELL_ALLOW_ENV, saved.shell]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("glob", () => {
  const m = (glob: string, p: string) => globToRegExp(glob).test(p);
  it("* и ? не пересекают слэш; точка — буквальная", () => {
    expect(m("*.txt", "a.txt")).toBe(true);
    expect(m("*.txt", "d/a.txt")).toBe(false);
    expect(m("*.txt", "aXtxt")).toBe(false);
    expect(m("?.js", "a.js")).toBe(true);
    expect(m("?.js", "ab.js")).toBe(false);
    expect(m("a.b", "aXb")).toBe(false);
  });
  it("наборы [abc] и [!abc]", () => {
    expect(m("[abc].txt", "b.txt")).toBe(true);
    expect(m("[abc].txt", "d.txt")).toBe(false);
    expect(m("[!a].txt", "b.txt")).toBe(true);
    expect(m("[!a].txt", "a.txt")).toBe(false);
  });
  it("** пересекает каталоги, ноль каталогов допустим", () => {
    expect(m("**/*.md", "a.md")).toBe(true);
    expect(m("**/*.md", "x/y/a.md")).toBe(true);
    expect(m("docs/**", "docs/a/b.txt")).toBe(true);
    expect(m("docs/**/*.md", "docs/a.md")).toBe(true);
    expect(m("docs/**/*.md", "other/a.md")).toBe(false);
  });
  it("спецсимволы regexp экранируются", () => {
    expect(m("a+b(1).txt", "a+b(1).txt")).toBe(true);
    expect(m("a+b.txt", "aab.txt")).toBe(false);
  });
  it("hasGlob / globBase", () => {
    expect(hasGlob("a/b.txt")).toBe(false);
    expect(hasGlob("a/*.txt")).toBe(true);
    expect(globBase("docs/2024/*.csv")).toBe("docs/2024");
    expect(globBase("*.txt")).toBe("");
    expect(globBase("a/**/b/*.x")).toBe("a");
    expect(globBase("a/b/c.txt")).toBe("a/b");
  });
});

describe("песочница путей", () => {
  it("assertRelativePath", () => {
    for (const bad of ["/etc/passwd", "\\win", "C:\\x", "C:/x", "..", "a/../b", "../a", "a\\..\\b", "a\0b"]) {
      expect(() => assertRelativePath(bad), JSON.stringify(bad)).toThrow();
    }
    for (const ok of ["a/b", "a..b", ".hidden", "dir/.hidden", "", "..name", "a/..name"]) expect(() => assertRelativePath(ok), ok).not.toThrow();
  });

  it("filesBaseDir создаёт каталог; без переменной — понятная ошибка", async () => {
    rmSync(dir, { recursive: true });
    expect(await filesBaseDir()).toBe(base);
    expect(existsSync(dir)).toBe(true);
    delete process.env[FILES_DIR_ENV];
    await expect(filesBaseDir()).rejects.toThrow(/FL0W_FILES_DIR/);
  });

  it("resolveInside: пути внутри (в том числе несуществующие) разрешены", async () => {
    expect(await resolveInside(base, "a/b/c.txt")).toBe(path.join(base, "a/b/c.txt"));
    expect(await resolveInside(base, "")).toBe(base);
  });

  it("симлинк наружу отвергается, симлинк внутрь — нет", async () => {
    writeFileSync(path.join(outside, "secret.txt"), "top secret");
    symlinkSync(outside, path.join(dir, "escape"));
    mkdirSync(path.join(dir, "real"));
    symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
    await expect(resolveInside(base, "escape/secret.txt")).rejects.toThrow(/outside/);
    await expect(resolveInside(base, "escape/new/file.txt")).rejects.toThrow(/outside/); // и для несуществующих
    await expect(resolveInside(base, "alias/x.txt")).resolves.toBe(path.join(base, "alias/x.txt"));
  });
});

describe("Files", () => {
  it("write → read (text), метаданные", async () => {
    const w = (await out0(Files, "hello", { operation: "write", path: "notes/a.txt" })) as { path: string; size: number; bytesWritten: number };
    expect(w).toMatchObject({ path: "notes/a.txt", size: 5, bytesWritten: 5 });
    expect(readFileSync(path.join(dir, "notes/a.txt"), "utf8")).toBe("hello");
    const r = (await out0(Files, undefined, { path: "notes/a.txt" })) as Record<string, Json>;
    expect(r).toMatchObject({ path: "notes/a.txt", name: "a.txt", type: "file", size: 5, content: "hello" });
    expect(new Date(r["modifiedAt"] as string).getTime()).toBeGreaterThan(0);
  });

  it("json: запись объекта и чтение обратно как объекта", async () => {
    await run(Files, { a: [1, { b: 2 }] }, { operation: "write", path: "d.json", format: "json" });
    expect(readFileSync(path.join(dir, "d.json"), "utf8")).toBe('{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}\n');
    expect(((await out0(Files, undefined, { path: "d.json", format: "json" })) as { content: Json }).content).toEqual({ a: [1, { b: 2 }] });
    writeFileSync(path.join(dir, "bad.json"), "{nope");
    await expect(run(Files, undefined, { path: "bad.json", format: "json" })).rejects.toThrow(/not valid JSON/);
  });

  it("base64: бинарные данные проходят без искажений", async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 128, 10]);
    await run(Files, bytes.toString("base64"), { operation: "write", path: "bin.dat", format: "base64" });
    expect(readFileSync(path.join(dir, "bin.dat"))).toEqual(bytes);
    expect(((await out0(Files, undefined, { path: "bin.dat", format: "base64" })) as { content: string }).content).toBe(bytes.toString("base64"));
    await expect(run(Files, { x: 1 }, { operation: "write", path: "x", format: "base64" })).rejects.toThrow(/must be a string/);
  });

  it("append дописывает; content и path поддерживают шаблоны; без content берётся вход", async () => {
    await run(Files, { who: "ann", n: 1 }, { operation: "write", path: "log-{{ who }}.txt", content: "first {{ n }}\n" });
    await run(Files, { who: "ann", n: 2 }, { operation: "append", path: "log-{{ who }}.txt", content: "second {{ n }}\n" });
    expect(readFileSync(path.join(dir, "log-ann.txt"), "utf8")).toBe("first 1\nsecond 2\n");
    await run(Files, "из входа", { operation: "write", path: "in.txt" });
    expect(readFileSync(path.join(dir, "in.txt"), "utf8")).toBe("из входа");
  });

  it("overwrite=false и createDirs=false", async () => {
    await run(Files, "a", { operation: "write", path: "x.txt" });
    await expect(run(Files, "b", { operation: "write", path: "x.txt", overwrite: false })).rejects.toThrow(/already exists/);
    await run(Files, "c", { operation: "write", path: "x.txt" }); // по умолчанию перезаписывает
    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("c");
    await expect(run(Files, "d", { operation: "write", path: "no/dir/y.txt", createDirs: false })).rejects.toThrow();
    expect(existsSync(path.join(dir, "no"))).toBe(false);
  });

  it("запись не оставляет временных файлов", async () => {
    await run(Files, "x", { operation: "write", path: "t.txt" });
    expect(await out0(Files, undefined, { operation: "list", path: "" })).toEqual([expect.objectContaining({ name: "t.txt" })]);
  });

  it("чтение несуществующего файла, каталога и слишком большого файла", async () => {
    await expect(run(Files, undefined, { path: "nope.txt" })).rejects.toThrow('"nope.txt" does not exist');
    mkdirSync(path.join(dir, "folder"));
    await expect(run(Files, undefined, { path: "folder" })).rejects.toThrow(/is not a file/);
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(run(Files, undefined, { path: "big.bin" })).rejects.toThrow(/larger than/);
    await expect(run(Files, "x".repeat(10 * 1024 * 1024 + 1), { operation: "write", path: "huge.txt" })).rejects.toThrow(/larger than/);
  });

  it("list: каталог и маска", async () => {
    for (const f of ["b.txt", "a.txt", "c.md", "sub/d.txt"]) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), f);
    }
    const names = (v: Json) => (v as { path: string }[]).map((e) => e.path);
    expect(names(await out0(Files, undefined, { operation: "list", path: "" }) as Json)).toEqual(["a.txt", "b.txt", "c.md", "sub"]);
    expect(names(await out0(Files, undefined, { operation: "list", path: "*.txt" }) as Json)).toEqual(["a.txt", "b.txt"]);
    expect(names(await out0(Files, undefined, { operation: "list", path: "**/*.txt" }) as Json)).toEqual(["a.txt", "b.txt", "sub/d.txt"]);
    expect(((await out0(Files, undefined, { operation: "list", path: "" })) as { type: string }[]).map((e) => e.type)).toEqual(["file", "file", "file", "dir"]);
  });

  it("чтение по маске возвращает список файлов с содержимым; симлинки не обходятся", async () => {
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs/1.txt"), "one");
    writeFileSync(path.join(dir, "docs/2.txt"), "two");
    writeFileSync(path.join(outside, "3.txt"), "leak");
    symlinkSync(outside, path.join(dir, "docs/link"));
    const r = (await out0(Files, undefined, { path: "docs/**/*.txt" })) as { path: string; content: string }[];
    expect(r.map((f) => [f.path, f.content])).toEqual([["docs/1.txt", "one"], ["docs/2.txt", "two"]]);
  });

  it("выход за каталог и абсолютные пути отвергаются на всех операциях", async () => {
    writeFileSync(path.join(outside, "secret.txt"), "s");
    for (const op of ["read", "write", "append", "list"]) {
      for (const p of ["../secret.txt", "/etc/passwd", "a/../../x", path.join(outside, "secret.txt")]) {
        await expect(run(Files, "x", { operation: op, path: p }), `${op} ${p}`).rejects.toThrow(/relative|\.\.|outside/);
      }
    }
    await expect(run(Files, undefined, { path: "../*" })).rejects.toThrow();
    symlinkSync(outside, path.join(dir, "link"));
    await expect(run(Files, undefined, { path: "link/secret.txt" })).rejects.toThrow(/outside/);
    await expect(run(Files, "x", { operation: "write", path: "link/new.txt" })).rejects.toThrow(/outside/);
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  it("запись по маске и пустой путь — ошибки", async () => {
    await expect(run(Files, "x", { operation: "write", path: "*.txt" })).rejects.toThrow(/pattern cannot be used/);
    await expect(run(Files, "x", { operation: "write", path: "" })).rejects.toThrow(/required/);
    await expect(run(Files, "x", { operation: "explode", path: "a" })).rejects.toThrow(/Unknown operation/);
    await expect(run(Files, "x", { path: "a", format: "yaml" })).rejects.toThrow(/Unknown format/);
  });
});

describe("Shell", () => {
  const sh = (params: Record<string, Json>, input: Json | undefined = null, ctx: Partial<RunContext> = {}) => out0(Shell, input, params, ctx) as Promise<Record<string, Json>>;

  it("по умолчанию отключён и говорит, как включить", async () => {
    delete process.env[SHELL_ALLOW_ENV];
    await expect(sh({ script: "echo hi" })).rejects.toThrow(/FL0W_ALLOW_SHELL=1/);
    process.env[SHELL_ALLOW_ENV] = "0";
    await expect(sh({ script: "echo hi" })).rejects.toThrow(/disabled/);
    process.env[SHELL_ALLOW_ENV] = "true";
    expect(await sh({ script: "echo hi" })).toMatchObject({ stdout: "hi\n", exitCode: 0 });
  });

  it("stdout, stderr, код выхода; sh тоже работает", async () => {
    expect(await sh({ script: "echo out; echo err >&2" })).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 0, signal: null });
    expect(await sh({ script: "echo $0", shell: "sh" })).toMatchObject({ stdout: "sh\n" });
  });

  it("args — позиционные параметры, а не часть скрипта: внедрить команду нельзя", async () => {
    const evil = ['$(touch pwned)', "; touch pwned2", "`touch pwned3`", "'; touch pwned4; '", '" && touch pwned5 && "'];
    const r = await sh({ script: 'printf "%s|" "$@"', args: evil });
    expect(r["stdout"]).toBe(`${evil.join("|")}|`); // дошли буквально
    for (const f of ["pwned", "pwned2", "pwned3", "pwned4", "pwned5"]) expect(existsSync(path.join(dir, f)), f).toBe(false);
  });

  it("args и env берут данные из входа через шаблоны; скрипт — нет", async () => {
    const r = await sh({ script: 'echo "$1/$2/$GREETING/{{ name }}"', args: ["{{ name }}", 42], env: { GREETING: "hi {{ name }}" } }, { name: "ann" });
    expect(r["stdout"]).toBe("ann/42/hi ann/{{ name }}\n"); // {{ name }} в самом скрипте остался как есть
  });

  it("stdin", async () => {
    expect((await sh({ script: "cat", stdin: "data {{ x }}" }, { x: 1 }))["stdout"]).toBe("data 1");
  });

  it("окружение изолировано: секреты процесса сервера не видны, имена env проверяются", async () => {
    process.env["TOP_SECRET_TOKEN"] = "s3cret";
    try {
      expect((await sh({ script: 'echo "${TOP_SECRET_TOKEN-unset}"' }))["stdout"]).toBe("unset\n");
      expect((await sh({ script: "echo $PATH" }))["stdout"]).not.toBe("\n"); // PATH проброшен
    } finally {
      delete process.env["TOP_SECRET_TOKEN"];
    }
    await expect(sh({ script: "true", env: { "BAD NAME": "x" } })).rejects.toThrow(/invalid environment variable name/);
    await expect(sh({ script: "true", env: { "A=B": "x" } })).rejects.toThrow(/invalid environment variable name/);
    await expect(sh({ script: "true", env: [1] })).rejects.toThrow(/"env" must be an object/);
    await expect(sh({ script: "true", args: "x" })).rejects.toThrow(/"args" must be a list/);
  });

  it("ненулевой код: ошибка с хвостом stderr; failOnError=false отдаёт результат", async () => {
    await expect(sh({ script: "echo boom >&2; exit 3" })).rejects.toThrow("Command failed with exit code 3: boom");
    expect(await sh({ script: "echo boom >&2; exit 3", failOnError: false })).toMatchObject({ exitCode: 3, stderr: "boom\n" });
    await expect(sh({ script: "kill -9 $$" })).rejects.toThrow(/signal SIGKILL/);
  });

  it("выполняется в каталоге файлов; cwd — только подпапка внутри него", async () => {
    expect((await sh({ script: "pwd" }))["stdout"]).toBe(`${base}\n`);
    mkdirSync(path.join(dir, "sub"));
    expect((await sh({ script: "pwd", cwd: "sub" }))["stdout"]).toBe(`${base}/sub\n`);
    await run(Files, "data", { operation: "write", path: "sub/f.txt" });
    expect((await sh({ script: "cat f.txt", cwd: "sub" }))["stdout"]).toBe("data");
    await expect(sh({ script: "pwd", cwd: ".." })).rejects.toThrow(/\.\./);
    await expect(sh({ script: "pwd", cwd: "/" })).rejects.toThrow(/relative/);
    symlinkSync(outside, path.join(dir, "esc"));
    await expect(sh({ script: "pwd", cwd: "esc" })).rejects.toThrow(/outside/);
  });

  /** Жив ли процесс с таким PID (сигнал 0 ничего не посылает, только проверяет существование). */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Ждём, пока потомок реально исчезнет (убитый процесс уходит не мгновенно). */
  const dies = async (pid: number) => {
    for (let i = 0; i < 40; i++) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const childPid = () => Number(readFileSync(path.join(dir, "child.pid"), "utf8").trim());

  it("таймаут убивает всю группу процессов, включая потомков", async () => {
    const t = Date.now();
    // sleep — фоновый потомок оболочки; его PID пишем в файл, чтобы проверить именно его
    await expect(sh({ script: "sleep 30 & echo $! > child.pid; wait", timeoutMs: 400 })).rejects.toThrow("Shell timed out after 400 ms");
    expect(Date.now() - t).toBeLessThan(5000);
    const pid = childPid();
    expect(pid).toBeGreaterThan(1);
    expect(await dies(pid), "потомок пережил таймаут").toBe(true);
  });

  it("отмена запуска убивает процесс и потомков; уже отменённый signal не стартует", async () => {
    const ac = new AbortController();
    const p = sh({ script: "sleep 30 & echo $! > child.pid; wait", timeoutMs: 60_000 }, null, { signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    await expect(p).rejects.toThrow("Aborted");
    expect(await dies(childPid()), "потомок пережил отмену").toBe(true);
    const done = new AbortController();
    done.abort();
    await expect(sh({ script: "touch should-not-exist" }, null, { signal: done.signal })).rejects.toThrow("Aborted");
    expect(existsSync(path.join(dir, "should-not-exist"))).toBe(false);
  });

  it("вывод ограничен 1 МБ с пометкой truncated", async () => {
    const r = await sh({ script: "head -c 3000000 /dev/zero | tr '\\0' 'x'", timeoutMs: 20_000 });
    expect((r["stdout"] as string).length).toBe(1024 * 1024);
    expect(r["truncated"]).toBe(true);
  });

  it("пустой скрипт и неизвестная оболочка", async () => {
    await expect(sh({ script: "   " })).rejects.toThrow(/empty/);
    await expect(sh({ script: "true", shell: "zsh" })).rejects.toThrow(/Unknown shell/);
  });
});

describe("триггеры: файлы, ошибки, жизненный цикл", () => {
  it("Local File Trigger: нормализация параметров и валидация пути", () => {
    expect(LocalFileTrigger.fileWatch({})).toEqual({ path: "", event: "any", pattern: "*", recursive: false });
    expect(LocalFileTrigger.fileWatch({ path: "./inbox/", event: "add", pattern: "*.csv", recursive: true })).toEqual({
      path: "inbox", event: "add", pattern: "*.csv", recursive: true,
    });
    expect(() => LocalFileTrigger.fileWatch({ path: "../x" })).toThrow(/\.\./);
    expect(() => LocalFileTrigger.fileWatch({ path: "/etc" })).toThrow(/relative/);
    expect(() => LocalFileTrigger.fileWatch({ event: "rename" })).toThrow(/Unknown event/);
  });

  it("Local File Trigger: run отдаёт данные события или пример", async () => {
    const data = { event: "change", path: "inbox/a.csv", name: "a.csv", size: 3, modifiedAt: "2024-01-01T00:00:00.000Z" };
    expect(await out0(LocalFileTrigger, undefined, {}, { triggerData: data })).toEqual(data);
    expect(await out0(LocalFileTrigger, undefined, { path: "inbox" })).toMatchObject({ event: "add", path: "inbox/example.txt", name: "example.txt" });
  });

  it("Error Trigger: область и данные", async () => {
    expect(ErrorTrigger.errorScope({})).toEqual({ flows: [] });
    expect(ErrorTrigger.errorScope({ flows: ["a", "b"] })).toEqual({ flows: ["a", "b"] });
    expect(ErrorTrigger.errorScope({ flows: "a, b" })).toEqual({ flows: ["a", "b"] });
    expect(() => ErrorTrigger.errorScope({ flows: [1] })).toThrow(/list of strings/);
    const data = { flow: { id: "f", name: "n" }, run: { id: "r", trigger: "t" }, error: { message: "m", node: "x" }, at: "now" };
    expect(await out0(ErrorTrigger, undefined, {}, { triggerData: data })).toEqual(data);
    expect(await out0(ErrorTrigger, undefined, {})).toMatchObject({ error: { message: "Example error" } });
  });

  it("Activation / Workflow Trigger: события по флагам", () => {
    expect(ActivationTrigger.lifecycle({})).toEqual({ publish: true, update: true, startup: true });
    expect(ActivationTrigger.lifecycle({ onPublish: false, onStartup: false })).toEqual({ publish: false, update: true, startup: false });
    expect(WorkflowTrigger.lifecycle({})).toEqual({ publish: true, update: true, startup: false });
    expect(WorkflowTrigger.lifecycle({ onUpdate: false })).toEqual({ publish: true, update: false, startup: false });
  });

  it("свойства триггеров и «чужие» хуки у остальных блоков равны null", () => {
    for (const t of [LocalFileTrigger, ErrorTrigger, ActivationTrigger, WorkflowTrigger]) {
      expect([t.isTrigger, t.autoTrigger, t.ports.inputs.length]).toEqual([true, true, 0]);
    }
    for (const cls of Object.values(registry)) {
      if (cls.type !== "local_file_trigger") expect(cls.fileWatch({}), cls.type).toBeNull();
      if (!["activation_trigger", "workflow_trigger"].includes(cls.type)) expect(cls.lifecycle({}), cls.type).toBeNull();
      if (cls.type !== "error_trigger") expect(cls.errorScope({}), cls.type).toBeNull();
    }
  });
});

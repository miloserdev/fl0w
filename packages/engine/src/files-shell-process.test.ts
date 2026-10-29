import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { runFlowInProcess } from "./spawn";
import { edge, flow, node } from "./test-helpers";

/** Дочерний процесс наследует окружение родителя — переменные задаём здесь. */
let dir: string;
const saved = { files: process.env["FL0W_FILES_DIR"], shell: process.env["FL0W_ALLOW_SHELL"] };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-proc-"));
  process.env["FL0W_FILES_DIR"] = dir;
  delete process.env["FL0W_ALLOW_SHELL"];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["FL0W_FILES_DIR", saved.files], ["FL0W_ALLOW_SHELL", saved.shell]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function run(f: ReturnType<typeof flow>) {
  const events: RunnerEvent[] = [];
  await runFlowInProcess(f, (e) => void events.push(e), { timeoutMs: 30_000 });
  const done = events.at(-1);
  return { events, done: done?.event === "flow:done" ? done : undefined };
}

describe("Files в отдельном процессе", () => {
  it("manual → write → read (json) → result: данные проходят через диск", async () => {
    const f = flow(
      [
        node("m", "manual"),
        node("data", "set", { fields: { items: [1, 2, 3], note: "report" }, keepOnlySet: true }),
        node("save", "files", { operation: "write", path: "reports/out.json", format: "json" }),
        node("load", "files", { operation: "read", path: "{{ path }}", format: "json" }),
        node("res", "result"),
      ],
      [edge("m", "data"), edge("data", "save"), edge("save", "load"), edge("load", "res")],
    );
    const { done } = await run(f);
    expect(done?.error).toBeUndefined();
    expect((done?.result as { content: Json }).content).toEqual({ items: [1, 2, 3], note: "report" });
    expect(JSON.parse(readFileSync(path.join(dir, "reports/out.json"), "utf8"))).toEqual({ items: [1, 2, 3], note: "report" });
  });

  it("выход за каталог файлов даёт node:error, раннер жив", async () => {
    const f = flow(
      [node("s", "source", { json: "x" }), node("bad", "files", { operation: "write", path: "../escape.txt" }), node("res", "result")],
      [edge("s", "bad"), edge("bad", "res")],
    );
    const { events, done } = await run(f);
    expect(events).toContainEqual({ event: "node:error", nodeId: "bad", error: expect.stringMatching(/\.\./) });
    expect(done?.error).toMatch(/^Node "bad" failed/);
    expect(existsSync(path.join(dir, "..", "escape.txt"))).toBe(false);
  });
});

describe("Shell в отдельном процессе", () => {
  const shellFlow = (params: Record<string, Json>) =>
    flow(
      [node("s", "source", { json: { who: "ann" } }), node("sh", "shell", params), node("res", "result")],
      [edge("s", "sh"), edge("sh", "res")],
    );

  it("по умолчанию отключён: понятная ошибка и ничего не выполнено", async () => {
    const { events, done } = await run(shellFlow({ script: "touch ran.txt" }));
    expect(events).toContainEqual({ event: "node:error", nodeId: "sh", error: expect.stringMatching(/FL0W_ALLOW_SHELL=1/) });
    expect(done?.error).toMatch(/disabled/);
    expect(existsSync(path.join(dir, "ran.txt"))).toBe(false);
  });

  it("с FL0W_ALLOW_SHELL=1 выполняет скрипт; данные приходят безопасно через args", async () => {
    process.env["FL0W_ALLOW_SHELL"] = "1";
    const { done } = await run(shellFlow({ script: 'echo "hello $1" && echo err >&2', args: ["{{ who }}; touch pwned"] }));
    expect(done?.error).toBeUndefined();
    expect(done?.result).toMatchObject({ stdout: "hello ann; touch pwned\n", stderr: "err\n", exitCode: 0 });
    expect(existsSync(path.join(dir, "pwned"))).toBe(false);
  });

  it("файлы и Shell работают в одном каталоге", async () => {
    process.env["FL0W_ALLOW_SHELL"] = "1";
    const f = flow(
      [
        node("s", "source", { json: "payload" }),
        node("w", "files", { operation: "write", path: "in.txt" }),
        node("sh", "shell", { script: 'wc -c < in.txt' }),
        node("res", "result"),
      ],
      [edge("s", "w"), edge("w", "sh"), edge("sh", "res")],
    );
    const { done } = await run(f);
    expect(String((done?.result as { stdout: string }).stdout).trim()).toBe("7");
  });

  it("ненулевой код — node:error с хвостом stderr", async () => {
    process.env["FL0W_ALLOW_SHELL"] = "1";
    const { events } = await run(shellFlow({ script: "echo nope >&2; exit 4" }));
    expect(events).toContainEqual({ event: "node:error", nodeId: "sh", error: "Command failed with exit code 4: nope" });
  });
});

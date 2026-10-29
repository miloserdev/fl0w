import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileWatchSpec } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import { createFileWatcher } from "./file-watch";

type Ev = { event: string; path: string; name: string; size?: number; modifiedAt?: string };

let dir: string;
let outside: string;
let stops: (() => void)[] = [];
let logs: string[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fl0w-watch-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "fl0w-watch-out-")));
  stops = [];
  logs = [];
});
afterEach(() => {
  for (const s of stops) s();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const spec = (over: Partial<FileWatchSpec> = {}): FileWatchSpec => ({ path: "", event: "any", pattern: "*", recursive: false, ...over });

/** Запускает наблюдателя и ждёт, пока он реально начнёт слушать (инициализация асинхронная). */
async function watching(s: FileWatchSpec) {
  const events: Ev[] = [];
  const factory = createFileWatcher({ baseDir: dir, debounceMs: 40, log: (m) => logs.push(m) });
  stops.push(factory(s, (p: Json) => void events.push(p as Ev)));
  await sleep(250);
  return events;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await sleep(20);
}
const settle = () => sleep(300); // тишина: убедиться, что лишних событий нет

describe("createFileWatcher", () => {
  it("add: новый файл даёт событие с путём, именем и размером; уже лежавшие файлы — нет", async () => {
    writeFileSync(path.join(dir, "old.txt"), "old");
    const events = await watching(spec());
    writeFileSync(path.join(dir, "new.txt"), "hello");
    await until(() => events.length > 0);
    await settle();
    expect(events).toEqual([{ event: "add", path: "new.txt", name: "new.txt", size: 5, modifiedAt: expect.any(String) }]);
  });

  it("change и unlink; у удалённого файла нет size и modifiedAt", async () => {
    writeFileSync(path.join(dir, "a.txt"), "1");
    const events = await watching(spec());
    appendFileSync(path.join(dir, "a.txt"), "22");
    await until(() => events.some((e) => e.event === "change"));
    unlinkSync(path.join(dir, "a.txt"));
    await until(() => events.some((e) => e.event === "unlink"));
    expect(events.map((e) => e.event)).toEqual(["change", "unlink"]);
    expect(events[0]).toMatchObject({ path: "a.txt", size: 3 });
    expect(events[1]).toEqual({ event: "unlink", path: "a.txt", name: "a.txt" });
  });

  it("серия быстрых записей сворачивается в одно срабатывание", async () => {
    const events = await watching(spec());
    for (let i = 0; i < 6; i++) appendFileSync(path.join(dir, "burst.log"), `line ${i}\n`);
    await until(() => events.length > 0);
    await settle();
    expect(events.map((e) => e.event)).toEqual(["add"]);
    expect(events[0]!.size).toBe("line 0\n".length * 6);
  });

  it("фильтр события: add не реагирует на change и unlink", async () => {
    writeFileSync(path.join(dir, "keep.txt"), "x");
    const events = await watching(spec({ event: "add" }));
    appendFileSync(path.join(dir, "keep.txt"), "y");
    unlinkSync(path.join(dir, "keep.txt"));
    await settle();
    writeFileSync(path.join(dir, "fresh.txt"), "z");
    await until(() => events.length > 0);
    expect(events.map((e) => [e.event, e.path])).toEqual([["add", "fresh.txt"]]);
  });

  it("маска имени: *.csv", async () => {
    const events = await watching(spec({ pattern: "*.csv" }));
    writeFileSync(path.join(dir, "a.txt"), "x");
    writeFileSync(path.join(dir, "b.csv"), "x");
    await until(() => events.length > 0);
    await settle();
    expect(events.map((e) => e.path)).toEqual(["b.csv"]);
  });

  it("подпапка: наблюдаемая папка и recursive", async () => {
    mkdirSync(path.join(dir, "inbox/deep"), { recursive: true });
    const shallow = await watching(spec({ path: "inbox" }));
    const deep = await watching(spec({ path: "inbox", recursive: true }));
    writeFileSync(path.join(dir, "inbox/a.txt"), "x");
    writeFileSync(path.join(dir, "inbox/deep/b.txt"), "x");
    writeFileSync(path.join(dir, "outside-of-inbox.txt"), "x");
    await until(() => deep.length >= 2);
    await settle();
    expect(shallow.map((e) => e.path)).toEqual(["inbox/a.txt"]);
    expect(deep.map((e) => e.path).sort()).toEqual(["inbox/a.txt", "inbox/deep/b.txt"]);
  });

  it("наблюдение за конкретным файлом: соседи не мешают", async () => {
    writeFileSync(path.join(dir, "target.txt"), "1");
    const events = await watching(spec({ path: "target.txt" }));
    writeFileSync(path.join(dir, "neighbour.txt"), "x");
    appendFileSync(path.join(dir, "target.txt"), "2");
    await until(() => events.length > 0);
    await settle();
    expect(events.map((e) => [e.event, e.path])).toEqual([["change", "target.txt"]]);
  });

  it("каталоги и симлинки событий не дают", async () => {
    const events = await watching(spec());
    mkdirSync(path.join(dir, "newdir"));
    symlinkSync(outside, path.join(dir, "link"));
    await settle();
    expect(events).toEqual([]);
  });

  it("stop прекращает доставку; stop до окончания инициализации не падает", async () => {
    const events = await watching(spec());
    stops.pop()!();
    writeFileSync(path.join(dir, "late.txt"), "x");
    await settle();
    expect(events).toEqual([]);

    const factory = createFileWatcher({ baseDir: dir, debounceMs: 20, log: (m) => logs.push(m) });
    const stop = factory(spec(), () => {
      throw new Error("must not be called");
    });
    stop(); // сразу, пока start() ещё идёт
    writeFileSync(path.join(dir, "later.txt"), "x");
    await settle();
    expect(logs.filter((l) => /not started|error/i.test(l))).toEqual([]);
  });

  it("несуществующий путь и выход за каталог — не падение, а запись в лог", async () => {
    await watching(spec({ path: "missing-dir" }));
    expect(logs.join("\n")).toMatch(/does not exist/);
    await watching(spec({ path: "../escape" }));
    expect(logs.join("\n")).toMatch(/not started: .*\.\./);
    symlinkSync(outside, path.join(dir, "ln"));
    await watching(spec({ path: "ln" }));
    expect(logs.join("\n")).toMatch(/outside/);
  });

  it("повторное создание удалённого файла снова add", async () => {
    writeFileSync(path.join(dir, "again.txt"), "1");
    const events = await watching(spec());
    unlinkSync(path.join(dir, "again.txt"));
    await until(() => events.length === 1);
    writeFileSync(path.join(dir, "again.txt"), "2");
    await until(() => events.length === 2);
    expect(events.map((e) => e.event)).toEqual(["unlink", "add"]);
  });
});

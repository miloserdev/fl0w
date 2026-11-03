import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@fl0w/schema";
import { resolveParams } from "./params";
import { Notification } from "./notify";
import { registry } from "./registry";

let dir: string;
const saved = { PATH: process.env["PATH"], secret: process.env["FL0W_SECRET_X"], dbus: process.env["DBUS_SESSION_BUS_ADDRESS"] };

/** Подменяет notify-send скриптом: аргументы по строке в args.txt, окружение — в env.txt; stderr/код — из аргументов теста. */
function fakeNotifySend(body = "") {
  const file = path.join(dir, "notify-send");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\nenv > "${dir}/env.txt"\n${body}\n`);
  chmodSync(file, 0o755);
  process.env["PATH"] = `${dir}:${saved.PATH}`;
}
const argv = () => readFileSync(path.join(dir, "args.txt"), "utf8").split("\n").slice(0, -1);

const run = (input: Json | undefined, params: Record<string, Json> = {}, signal = new AbortController().signal) =>
  new Notification().run(input === undefined ? {} : { in0: input }, resolveParams(Notification.params, params), { log() {}, signal });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-notify-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env["PATH"] = saved.PATH;
  for (const [k, v] of [["FL0W_SECRET_X", saved.secret], ["DBUS_SESSION_BUS_ADDRESS", saved.dbus]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Notification (notify-send)", () => {
  it("зарегистрирован как notify и передаёт вход дальше без изменений", async () => {
    expect(registry["notify"]).toBe(Notification);
    fakeNotifySend();
    expect(await run({ a: 1 }, { title: "T", message: "M" })).toEqual({ out0: { a: 1 } });
  });

  it("аргументы: срочность, имя приложения, иконка, время; заголовок и текст — после `--`; {{ путь }} из входа", async () => {
    fakeNotifySend();
    await run({ user: { name: "Ann" } }, { title: "Привет, {{ user.name }}", message: "Заказ {{ user.name }}", urgency: "critical", icon: "dialog-warning", appName: "Flow", timeoutMs: 3000 });
    expect(argv()).toEqual(["-u", "critical", "-a", "Flow", "-i", "dialog-warning", "-t", "3000", "--", "Привет, Ann", "Заказ Ann"]);
  });

  it("пустой текст — весь вход; без иконки и времени этих флагов нет", async () => {
    fakeNotifySend();
    await run({ x: 1 }, { title: "T" });
    expect(argv()).toEqual(["-u", "normal", "-a", "Node Flow Board", "--", "T", '{"x":1}']);
  });

  it("данные, похожие на флаги, остаются текстом (после `--`) и не становятся аргументами команды", async () => {
    fakeNotifySend();
    await run(undefined, { title: "--hint=string:x:y", message: "-h int:urgency:2; rm -rf /" });
    const a = argv();
    expect(a.slice(a.indexOf("--"))).toEqual(["--", "--hint=string:x:y", "-h int:urgency:2; rm -rf /"]);
  });

  it("окружение: только PATH/сессия рабочего стола, секреты сервера команде не передаются", async () => {
    fakeNotifySend();
    process.env["FL0W_SECRET_X"] = "super-secret";
    process.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus";
    await run(undefined, { title: "T", message: "M" });
    const env = readFileSync(path.join(dir, "env.txt"), "utf8");
    expect(env).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus");
    expect(env).not.toContain("super-secret");
    expect(env).not.toContain("FL0W_SECRET_X");
  });

  it("ошибки параметров: пусто, срочность, иконка-путь, время", async () => {
    fakeNotifySend();
    await expect(run(undefined, { title: "", message: "" })).rejects.toThrow(/both empty/);
    await expect(run(undefined, { title: "T", message: "M", urgency: "boom" })).rejects.toThrow(/Unknown urgency/);
    await expect(run(undefined, { title: "T", message: "M", icon: "/etc/passwd" })).rejects.toThrow(/icon name/);
    await expect(run(undefined, { title: "T", message: "M", icon: "../x" })).rejects.toThrow(/icon name/);
    await expect(run(undefined, { title: "T", message: "M", timeoutMs: -1 })).rejects.toThrow(/timeoutMs/);
  });

  it("нет notify-send — понятная ошибка с подсказкой, что установить", async () => {
    process.env["PATH"] = dir; // пустой каталог
    await expect(run(undefined, { title: "T", message: "M" })).rejects.toThrow(/notify-send. not found.*libnotify/);
  });

  it("notify-send завершился с ошибкой — в тексте stderr; про отсутствие сессии — подсказка", async () => {
    fakeNotifySend('echo "Cannot autolaunch D-Bus without X11 $DISPLAY" >&2; exit 1');
    await expect(run(undefined, { title: "T", message: "M" })).rejects.toThrow(/Cannot autolaunch.*no desktop session/);
  });

  it("отмена запуска прерывает ожидание команды", async () => {
    fakeNotifySend("sleep 5");
    const ac = new AbortController();
    const p = run(undefined, { title: "T", message: "M" }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow("Aborted");
  });
});

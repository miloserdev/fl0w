import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { interpolate } from "./json-path";
import { textOf } from "./value-io";

export const NOTIFY_URGENCIES = ["low", "normal", "critical"] as const;
const MAX_TITLE = 200;
const MAX_BODY = 2000;
const MAX_TIMEOUT_MS = 600_000;
/** Только имя иконки из темы («dialog-information», «mail-unread»): путь к файлу не принимаем. */
const ICON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Что нужно `notify-send`, чтобы найти сессию рабочего стола; остальное окружение сервера (токены, ключи) команде не отдаём. */
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP"];

/**
 * Notification: показывает уведомление рабочего стола на машине, где работает сервер (KDE Plasma, GNOME и любой
 * демон уведомлений freedesktop — через `notify-send` из libnotify). Данные проходят дальше без изменений.
 *
 * Команда запускается без оболочки, аргументами-массивом, а заголовок и текст идут после `--`: данные из входа не могут
 * стать флагом или командой. В `title`/`message` работают `{{ путь }}` из входа; пустой `message` — весь вход как текст.
 * Нужны `notify-send` в PATH и сессия рабочего стола (D-Bus) у процесса сервера: в Docker-контейнере без проброса
 * сессионной шины блок отвечает понятной ошибкой.
 */
export class Notification extends Block {
  static type = "notify";
  static label = "Notification";
  static icon = "bell";
  static category = "io";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "title", type: "string", default: "Node Flow Board" },
    { name: "message", type: "string", multiline: true, default: "" },
    { name: "urgency", type: "enum", default: "normal", options: NOTIFY_URGENCIES.map((value) => ({ value })) },
    // имя иконки из темы; пусто — без иконки
    { name: "icon", type: "string", default: "" },
    { name: "appName", type: "string", default: "Node Flow Board" },
    // сколько показывать, мс; 0 — как решит демон уведомлений (у critical — пока не закроют)
    { name: "timeoutMs", type: "number", default: 0, min: 0, max: MAX_TIMEOUT_MS },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx: RunContext): Promise<Record<string, Json>> {
    const data = inputs["in0"] ?? null;
    const text = (name: string, fallback = "") => {
      const raw = typeof params[name] === "string" ? (params[name] as string) : fallback;
      return textOf(interpolate(raw, data)).replace(/\0/g, "");
    };

    const title = text("title").slice(0, MAX_TITLE);
    const rawMessage = typeof params["message"] === "string" ? params["message"] : "";
    const message = (rawMessage.trim() === "" ? (data === null ? "" : textOf(data)) : text("message")).replace(/\0/g, "").slice(0, MAX_BODY);
    if (title.trim() === "" && message.trim() === "") throw new Error("Notification: title and message are both empty");

    const urgency = String(params["urgency"] ?? "normal");
    if (!(NOTIFY_URGENCIES as readonly string[]).includes(urgency)) throw new Error(`Unknown urgency "${urgency}"`);
    const icon = typeof params["icon"] === "string" ? params["icon"].trim() : "";
    if (icon !== "" && !ICON_NAME.test(icon)) throw new Error('Notification: "icon" must be an icon name from the theme (letters, digits, . _ -)');
    const appName = (typeof params["appName"] === "string" ? params["appName"] : "").replace(/\0/g, "").trim().slice(0, 100) || "Node Flow Board";
    const timeoutMs = Math.trunc(Number(params["timeoutMs"] ?? 0));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Notification: "timeoutMs" must be 0…${MAX_TIMEOUT_MS}`);

    const args = ["-u", urgency, "-a", appName];
    if (icon !== "") args.push("-i", icon);
    if (timeoutMs > 0) args.push("-t", String(timeoutMs));
    args.push("--", title, message);

    const env: Record<string, string> = {};
    for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;

    const cp = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:child_process");
    await new Promise<void>((resolve, reject) => {
      cp.execFile("notify-send", args, { env: env as NodeJS.ProcessEnv, timeout: 10_000, signal: ctx.signal, windowsHide: true }, (err, _out, stderr) => {
        if (!err) return resolve();
        if (ctx.signal.aborted) return reject(new Error("Aborted"));
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new Error("Notification: `notify-send` not found. Install libnotify (Arch/Manjaro: libnotify; Debian/Ubuntu: libnotify-bin) on the machine that runs the server"));
        const tail = String(stderr).trim().slice(-300);
        reject(new Error(`Notification failed: ${tail || err.message}${tail.includes("D-Bus") || tail.includes("Cannot autolaunch") ? " (the server has no desktop session: DBUS_SESSION_BUS_ADDRESS)" : ""}`));
      });
    });
    ctx.log(`notification: ${title}`);
    return { out0: data };
  }
}

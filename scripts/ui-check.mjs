#!/usr/bin/env node
// Проверка интерфейса в headless Chromium: открывает приложение, при желании подставляет флоу, выполняет шаги
// (клики, ожидания, скриншоты, JS), собирает ошибки консоли. Нужен запущенный dev-сервер.
//
//   node scripts/ui-check.mjs --flow examples/showcase.json --theme dark \
//     --steps '[{"click":"text:Запустить"},{"wait":3000},{"shot":"after-run"},{"eval":"document.title","print":true}]'
//
// Опции: --url (http://localhost:3001) --flow <json> --theme light|dark --steps '<json>'|--steps-file <path>
//        --out <каталог скриншотов> --width 1500 --height 900 --allow-problems
// Шаги: {"click":"text:<подстрока кнопки>"|"css:<селектор>"} {"wait":ms} {"waitFor":"<css>"} {"shot":"имя"}
//       {"drag":[x1,y1,x2,y2]} — перетаскивание левой кнопкой
//       {"eval":"js","print":true} {"press":"Escape"} {"type":"текст с пробелами","delay":0}
//       type — набор по клавишам (keyDown/keyUp с text), как настоящий ввод; delay — пауза между символами, мс
// Вывод — JSON; код выхода 1, если в консоли были ошибки (если не задан --allow-problems).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const url = args.url ?? "http://localhost:3001";
const out = args.out ?? path.join(tmpdir(), "fl0w-ui-check");
const steps = args["steps-file"] ? JSON.parse(readFileSync(args["steps-file"], "utf8")) : JSON.parse(args.steps ?? "[]");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(path.join(tmpdir(), "fl0w-chrome-"));
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(process.env.CHROMIUM ?? "/usr/bin/chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${args.width ?? 1500},${args.height ?? 900}`, "--no-proxy-server", "about:blank",
], { stdio: "ignore" });

const result = { steps: [], shots: [], problems: [] };
let ws;
const cleanup = () => {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {}
    await sleep(200);
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) return void (pending.get(d.id)(d), pending.delete(d.id));
    if (d.method === "Runtime.exceptionThrown") result.problems.push("EXCEPTION " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 400));
    if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) {
      result.problems.push(d.params.type.toUpperCase() + " " + d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const click = async (x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };
  const center = (target) => {
    const sel = target.startsWith("text:")
      ? `[...document.querySelectorAll("button, [role=tab], [role=menuitem]")].find((b) => b.textContent.includes(${JSON.stringify(target.slice(5))}))`
      : `document.querySelector(${JSON.stringify(target.replace(/^css:/, ""))})`;
    return evalJs(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!e.disabled }; })()`);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await sleep(2500);
  if (args.flow || args.theme) {
    const flow = args.flow ? readFileSync(args.flow, "utf8") : null;
    await evalJs(`${flow ? `localStorage.setItem("fl0w:flow:v1", ${JSON.stringify(flow)});` : ""}${args.theme ? `localStorage.setItem("theme", ${JSON.stringify(args.theme)});` : ""}`);
    await send("Page.navigate", { url });
    await sleep(3500);
  }

  for (const [i, step] of steps.entries()) {
    const entry = { i, ...step };
    if (step.click) {
      const c = await center(step.click);
      entry.found = !!c;
      entry.disabled = c?.disabled ?? null;
      if (c && !c.disabled) await click(c.x, c.y);
    } else if (step.drag) {
      // {"drag":[x1,y1,x2,y2]} — перетаскивание левой кнопкой (рамка выделения, перенос нод)
      const [x1, y1, x2, y2] = step.drag;
      const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
      await mouse("mouseMoved", x1, y1);
      await mouse("mousePressed", x1, y1);
      for (let i = 1; i <= 10; i++) await mouse("mouseMoved", x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10);
      await mouse("mouseReleased", x2, y2);
      await sleep(step.after ?? 400);
    } else if (step.wait) await sleep(step.wait);
    else if (step.waitFor) {
      const t = Date.now();
      while (!(await evalJs(`!!document.querySelector(${JSON.stringify(step.waitFor)})`)) && Date.now() - t < (step.timeout ?? 8000)) await sleep(100);
      entry.found = await evalJs(`!!document.querySelector(${JSON.stringify(step.waitFor)})`);
    } else if (step.type !== undefined) {
      for (const ch of String(step.type)) {
        const space = ch === " ";
        const base = { key: ch, code: space ? "Space" : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : undefined, windowsVirtualKeyCode: space ? 32 : /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0 };
        await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, ...base });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        if (step.delay) await sleep(step.delay);
      }
    } else if (step.press) {
      // коды клавиш: без windowsVirtualKeyCode Chromium вставляет имя клавиши как текст
      const codes = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
      const k = { key: step.press, code: step.press, windowsVirtualKeyCode: codes[step.press] ?? 0 };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    } else if (step.eval) entry.value = await evalJs(step.eval);
    if (step.click || step.press) await sleep(step.after ?? 500);
    if (step.shot) {
      const file = path.join(out, `${step.shot}.png`);
      writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
      result.shots.push(file);
    }
    result.steps.push(entry);
  }
} catch (e) {
  result.problems.push(`CHECK FAILED ${e instanceof Error ? e.message : String(e)}`);
} finally {
  cleanup();
}
result.problems = [...new Set(result.problems)];
console.log(JSON.stringify(result, null, 2));
process.exit(result.problems.length && !args["allow-problems"] ? 1 : 0);

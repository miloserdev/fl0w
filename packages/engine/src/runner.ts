/**
 * Точка входа дочернего процесса (SPEC §5): один запуск флоу = один процесс.
 * Протокол по IPC: web → runner `{ cmd: "run", flow }`, runner → web события `RunnerEvent`.
 * Запускается через `fork`; сам ничего не слушает, кроме одной команды, и завершается после `flow:done`.
 */
import type { Json, RunnerEvent } from "@fl0w/schema";
import { runFlow } from "./run";

function send(event: RunnerEvent): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send!(event, () => resolve());
  });
}

process.once("message", async (raw: unknown) => {
  // отправки идут строго по порядку, иначе события могут обогнать друг друга
  let chain = Promise.resolve();
  // возвращаем цепочку: runFlow дожидается доставки node:start/node:done до запуска следующего блока
  const emit = (e: RunnerEvent): Promise<void> => {
    chain = chain.then(() => send(e));
    return chain;
  };

  const cmd =
    typeof raw === "object" && raw !== null ? (raw as { cmd?: unknown; flow?: unknown; trigger?: unknown; triggerData?: unknown }) : {};
  if (cmd.cmd !== "run") {
    emit({ event: "flow:done", error: "Unknown runner command" });
  } else {
    // валидация флоу — внутри runFlow, он же формирует внятную ошибку
    await runFlow(cmd.flow, emit, {
      trigger: typeof cmd.trigger === "string" ? cmd.trigger : undefined,
      triggerData: cmd.triggerData as Json | undefined,
    });
  }

  await chain;
  process.exit(0);
});

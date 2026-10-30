/**
 * Точка входа дочернего процесса (SPEC §5): один запуск флоу = один процесс.
 * Протокол по IPC: web → runner `{ cmd: "run", flow }`, runner → web события `RunnerEvent`.
 * Запускается через `fork`; сам ничего не слушает, кроме одной команды, и завершается после `flow:done`.
 */
import type { FireReply, FireRequest, Json, RunnerEvent } from "@fl0w/schema";
import { runFlow } from "./run";

function send(event: RunnerEvent | FireRequest): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send!(event, () => resolve());
  });
}

// запросы «запустить другой флоу» ждут ответа родителя: сопоставляем по id
const pendingFires = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
let fireSeq = 0;
const fire = (req: { flowId: string; triggerId: string; data: Json }): Promise<void> =>
  new Promise((resolve, reject) => {
    const id = String(++fireSeq);
    pendingFires.set(id, { resolve, reject });
    void send({ event: "fire", id, ...req });
  });
process.on("message", (raw: unknown) => {
  const reply = raw as Partial<FireReply> | null;
  if (reply?.cmd !== "fire:result" || typeof reply.id !== "string") return;
  const p = pendingFires.get(reply.id);
  pendingFires.delete(reply.id);
  if (reply.error !== undefined) p?.reject(new Error(reply.error));
  else p?.resolve();
});

process.once("message", async (raw: unknown) => {
  // отправки идут строго по порядку, иначе события могут обогнать друг друга
  let chain = Promise.resolve();
  // возвращаем цепочку: runFlow дожидается доставки node:start/node:done до запуска следующего блока
  const emit = (e: RunnerEvent): Promise<void> => {
    chain = chain.then(() => send(e));
    return chain;
  };

  const cmd =
    typeof raw === "object" && raw !== null ? (raw as { cmd?: unknown; flow?: unknown; trigger?: unknown; triggerData?: unknown; from?: unknown; seeds?: unknown }) : {};
  if (cmd.cmd !== "run") {
    emit({ event: "flow:done", error: "Unknown runner command" });
  } else {
    // валидация флоу — внутри runFlow, он же формирует внятную ошибку
    await runFlow(cmd.flow, emit, {
      trigger: typeof cmd.trigger === "string" ? cmd.trigger : undefined,
      triggerData: cmd.triggerData as Json | undefined,
      from: typeof cmd.from === "string" ? cmd.from : undefined,
      seeds: cmd.seeds as Record<string, Record<string, Json>> | undefined,
      fire,
    });
  }

  await chain;
  process.exit(0);
});

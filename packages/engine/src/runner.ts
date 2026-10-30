/**
 * Точка входа дочернего процесса (SPEC §5): один запуск флоу = один процесс.
 * Протокол по IPC: web → runner `{ cmd: "run", flow }`, runner → web события `RunnerEvent`.
 * Запускается через `fork`; сам ничего не слушает, кроме одной команды, и завершается после `flow:done`.
 */
import type { CallResolveReply, CallResolveRequest, Json, RunnerEvent } from "@fl0w/schema";
import { PauseGate } from "./pause-gate";
import { runFlow } from "./run";

function send(event: RunnerEvent | CallResolveRequest): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send!(event, () => resolve());
  });
}

// запросы «найти флоу по каналу» (outgoing call) ждут ответа родителя: сопоставляем по id
const pendingResolves = new Map<string, { resolve: (v: { flow: unknown; triggerId: string }) => void; reject: (e: Error) => void }>();
let resolveSeq = 0;
const resolveCall = (channelId: string): Promise<{ flow: unknown; triggerId: string }> =>
  new Promise((resolve, reject) => {
    const id = String(++resolveSeq);
    pendingResolves.set(id, { resolve, reject });
    void send({ event: "call:resolve", id, channelId });
  });
const gate = new PauseGate();
let emitEvent: ((e: RunnerEvent) => unknown) | undefined;
process.on("message", (raw: unknown) => {
  const ctl = (raw as { cmd?: unknown } | null)?.cmd;
  if (ctl === "pause" || ctl === "resume") {
    if (ctl === "pause") gate.pause();
    else gate.resume();
    void emitEvent?.({ event: "run:paused", paused: gate.paused });
    return;
  }
  const reply = raw as Partial<CallResolveReply> | null;
  if (reply?.cmd !== "call:resolved" || typeof reply.id !== "string") return;
  const p = pendingResolves.get(reply.id);
  pendingResolves.delete(reply.id);
  if (reply.error !== undefined) p?.reject(new Error(reply.error));
  else p?.resolve({ flow: reply.flow, triggerId: String(reply.triggerId ?? "") });
});

process.once("message", async (raw: unknown) => {
  // отправки идут строго по порядку, иначе события могут обогнать друг друга
  let chain = Promise.resolve();
  // возвращаем цепочку: runFlow дожидается доставки node:start/node:done до запуска следующего блока
  const emit = (e: RunnerEvent): Promise<void> => {
    chain = chain.then(() => send(e));
    return chain;
  };

  emitEvent = emit;
  const cmd =
    typeof raw === "object" && raw !== null ? (raw as { cmd?: unknown; flow?: unknown; trigger?: unknown; triggerData?: unknown; from?: unknown; seeds?: unknown; pins?: unknown }) : {};
  if (cmd.cmd !== "run") {
    emit({ event: "flow:done", error: "Unknown runner command" });
  } else {
    // валидация флоу — внутри runFlow, он же формирует внятную ошибку
    await runFlow(cmd.flow, emit, {
      trigger: typeof cmd.trigger === "string" ? cmd.trigger : undefined,
      triggerData: cmd.triggerData as Json | undefined,
      pins: cmd.pins === true ? true : undefined,
      from: typeof cmd.from === "string" ? cmd.from : undefined,
      seeds: cmd.seeds as Record<string, Record<string, Json>> | undefined,
      resolveCall,
      gate,
    });
  }

  await chain;
  process.exit(0);
});

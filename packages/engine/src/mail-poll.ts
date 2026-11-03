/** Node-only. Опрос почтового ящика для Mail Trigger. Экспортируется через `@fl0w/engine/server`. */
import { buildMailDriver, redactSecrets, saveMailAttachments, withAttachmentPaths, type MailDriver, type MailWatchSpec } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import type { MailPollFactory } from "./scheduler";

export type MailPollerOptions = {
  /** Паузы между повторами после сбоя: минимум и максимум, мс (растёт вдвое). */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Сколько писем обрабатывать за один опрос (остальные — в следующем). */
  batch?: number;
  /** Сколько идентификаторов «уже видел» помнить. */
  seenLimit?: number;
  /** Для тестов: свой драйвер вместо настоящего. */
  makeDriver?: (spec: MailWatchSpec, signal: AbortSignal) => MailDriver;
  log?: (msg: string) => void;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Один опрос ящика на триггер: раз в `intervalSec` берёт письма по фильтрам, для ещё не виденных запускает флоу (по письму — один запуск,
 * старые первыми) и, если задано `action: markRead`, помечает письмо прочитанным. Уже лежащие на момент старта письма пропускаются,
 * кроме режима `markRead` или `processExisting` — их обрабатываем (иначе почта «не пришла» бы). При сбое (нет сети, неверный пароль)
 * повторяет с растущей паузой; пароль в сообщениях вырезается.
 */
export function createMailPoller(opts: MailPollerOptions = {}): MailPollFactory {
  const retryMin = opts.retryMinMs ?? 5000;
  const retryMax = opts.retryMaxMs ?? 5 * 60_000;
  const batch = opts.batch ?? 20;
  const seenLimit = opts.seenLimit ?? 2000;
  const log = opts.log ?? (() => {});

  return (spec, onMail) => {
    const abort = new AbortController();
    const seen = new Set<string>();
    let first = true;
    const remember = (id: string) => {
      seen.add(id);
      if (seen.size > seenLimit) seen.delete(seen.values().next().value as string);
    };
    const label = `${String(spec.connection["provider"] ?? "imap")} ${spec.username}`;

    const pollOnce = async () => {
      const driver = opts.makeDriver
        ? opts.makeDriver(spec, abort.signal)
        : buildMailDriver(String(spec.connection["provider"] ?? "imap"), spec.connection, { username: spec.username, password: spec.password, timeoutMs: 30_000, signal: abort.signal });
      try {
        const listed = await driver.list({ folder: spec.folder, unreadOnly: spec.unreadOnly, from: spec.fromFilter, subject: spec.subjectFilter, since: null, limit: 100 });
        // письмо уже обработано, но осталось непрочитанным (пометка не удалась) — повторяем только пометку, флоу не запускаем
        if (spec.action === "markRead") {
          for (const m of listed) if (seen.has(m.id) && m.unread) await driver.markRead(spec.folder, m.id, true);
        }
        // старые первыми: порядок обработки — порядок прихода
        const fresh = listed.filter((m) => !seen.has(m.id)).reverse();
        if (first) {
          first = false;
          if (!spec.processExisting && spec.action !== "markRead") {
            for (const m of fresh) remember(m.id);
            if (fresh.length > 0) log(`mail trigger ${label}: ${fresh.length} existing message(s) skipped (processExisting is off)`);
            return;
          }
        }
        for (const m of fresh.slice(0, batch)) {
          if (abort.signal.aborted) return;
          const full = await driver.get(spec.folder, m.id);
          let payload: Json = typeof full === "object" && full !== null && !Array.isArray(full) ? { ...full, folder: spec.folder } : { id: m.id, folder: spec.folder };
          if (spec.saveAttachments && typeof payload === "object" && payload !== null && !Array.isArray(payload) && Array.isArray(payload["attachments"]) && payload["attachments"].length > 0) {
            const saved = await saveMailAttachments(spec.attachmentsDir, m.id, await driver.attachments(spec.folder, m.id));
            payload = { ...payload, attachments: withAttachmentPaths(payload["attachments"], saved) };
          }
          remember(m.id);
          onMail(payload);
          if (spec.action === "markRead") await driver.markRead(spec.folder, m.id, true);
        }
      } finally {
        await driver.close().catch(() => undefined);
      }
    };

    void (async () => {
      let wait = retryMin;
      while (!abort.signal.aborted) {
        try {
          await pollOnce();
          wait = retryMin;
          await sleep(spec.intervalSec * 1000, abort.signal);
        } catch (e) {
          if (abort.signal.aborted) return;
          log(`mail trigger ${label}: ${redactSecrets(e instanceof Error ? e.message : String(e), [spec.password])} — retry in ${Math.round(wait / 1000)} s`);
          await sleep(wait, abort.signal);
          wait = Math.min(wait * 2, retryMax);
        }
      }
    })();

    return () => abort.abort();
  };
}

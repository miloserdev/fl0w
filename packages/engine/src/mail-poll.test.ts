import { describe, expect, it } from "vitest";
import type { MailDriver, MailItem, MailWatchSpec } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import { createMailPoller } from "./mail-poll";

const spec = (over: Partial<MailWatchSpec> = {}): MailWatchSpec => ({
  connection: { provider: "imap", host: "h" },
  username: "me@x.io",
  password: "pw-secret-9",
  folder: "INBOX",
  unreadOnly: true,
  fromFilter: "",
  subjectFilter: "",
  intervalSec: 0.03,
  action: "none",
  saveAttachments: false,
  attachmentsDir: "mail",
  processExisting: false,
  ...over,
});

/** Поддельный ящик: письма добавляются в ходе теста, драйвер ведёт журнал вызовов. */
function mailbox() {
  const box: MailItem[] = [];
  const calls: string[] = [];
  let failWith: string | null = null;
  const driver = (): MailDriver => ({
    async send() { return {}; },
    async list(q) {
      calls.push(`list ${q.folder} unread=${q.unreadOnly}`);
      if (failWith) throw new Error(failWith);
      // как у настоящих драйверов: новые первыми
      return box.filter((m) => !q.unreadOnly || m.unread).sort((a, b) => Number(b.id) - Number(a.id));
    },
    async get(_f, id) { calls.push(`get ${id}`); return { id, subject: `Письмо ${id}`, attachments: [] }; },
    async markRead(_f, id) { calls.push(`markRead ${id}`); const m = box.find((x) => x.id === id); if (m) m.unread = false; return {}; },
    async reply() { return {}; },
    async move() { return {}; },
    async attachments() { return []; },
    async close() { calls.push("close"); },
  });
  return {
    box,
    calls,
    driver,
    add: (id: string) => box.push({ id, from: "a@b.io", to: [], subject: id, date: null, unread: true }),
    fail: (m: string | null) => (failWith = m),
  };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await tick(10);
  }
}

describe("опрос почты (Mail Trigger)", () => {
  it("уже лежащие письма пропускаются, новые запускают флоу по одному и без повторов", async () => {
    const m = mailbox();
    m.add("1"); m.add("2");
    const got: Json[] = [];
    const stop = createMailPoller({ makeDriver: m.driver })(spec(), (x) => got.push(x));
    await tick(80);
    expect(got).toEqual([]); // 1 и 2 были до публикации
    m.add("3");
    await until(() => got.length === 1);
    await tick(100); // ещё несколько опросов — письмо 3 не должно повториться
    expect(got).toEqual([{ id: "3", subject: "Письмо 3", attachments: [], folder: "INBOX" }]);
    stop();
  });

  it("несколько новых писем — старые первыми", async () => {
    const m = mailbox();
    const got: Json[] = [];
    const stop = createMailPoller({ makeDriver: m.driver })(spec(), (x) => got.push(x));
    await tick(60);
    m.add("5"); m.add("6"); m.add("7");
    await until(() => got.length === 3);
    expect(got.map((x) => (x as { id: string }).id)).toEqual(["5", "6", "7"]);
    stop();
  });

  it("processExisting и action=markRead обрабатывают письма, уже лежавшие в ящике", async () => {
    for (const over of [{ processExisting: true }, { action: "markRead" as const }]) {
      const m = mailbox();
      m.add("1"); m.add("2");
      const got: Json[] = [];
      const stop = createMailPoller({ makeDriver: m.driver })(spec(over), (x) => got.push(x));
      await until(() => got.length === 2);
      expect(got.map((x) => (x as { id: string }).id)).toEqual(["1", "2"]);
      stop();
    }
  });

  it("action=markRead помечает письмо прочитанным после запуска; none — не трогает", async () => {
    const mark = mailbox();
    const gotA: Json[] = [];
    const stopA = createMailPoller({ makeDriver: mark.driver })(spec({ action: "markRead" }), (x) => gotA.push(x));
    await tick(60);
    mark.add("9");
    await until(() => mark.calls.includes("markRead 9"));
    expect(mark.box[0]!.unread).toBe(false);
    expect(gotA).toHaveLength(1);
    stopA();

    const none = mailbox();
    const stopB = createMailPoller({ makeDriver: none.driver })(spec(), () => {});
    await tick(60);
    none.add("9");
    await tick(150);
    expect(none.calls.some((c) => c.startsWith("markRead"))).toBe(false);
    stopB();
  });

  it("соединение закрывается после каждого опроса; stop прекращает опрос", async () => {
    const m = mailbox();
    const stop = createMailPoller({ makeDriver: m.driver })(spec(), () => {});
    await until(() => m.calls.filter((c) => c === "close").length >= 2);
    stop();
    await tick(60);
    const n = m.calls.length;
    await tick(150);
    expect(m.calls.length).toBe(n);
  });

  it("сбой опроса: повтор с паузой, пароль в логе вырезан, после восстановления письма приходят", async () => {
    const m = mailbox();
    m.fail("auth failed for pw-secret-9");
    const logs: string[] = [];
    const got: Json[] = [];
    const stop = createMailPoller({ makeDriver: m.driver, retryMinMs: 20, retryMaxMs: 40, log: (l) => logs.push(l) })(spec({ processExisting: true }), (x) => got.push(x));
    await until(() => logs.length >= 2);
    expect(logs[0]).toContain("auth failed for ***");
    expect(logs.join("\n")).not.toContain("pw-secret-9");
    m.fail(null);
    m.add("1");
    await until(() => got.length === 1);
    stop();
  });

  it("одно письмо не обрабатывается дважды, даже если обработка прошла сбой посередине", async () => {
    const m = mailbox();
    const got: Json[] = [];
    let first = true;
    const inner = m.driver();
    const flaky = (): MailDriver => ({ ...inner, async markRead(f, id, r) { if (first) { first = false; throw new Error("mark failed"); } return inner.markRead(f, id, r); } });
    const stop = createMailPoller({ makeDriver: flaky, retryMinMs: 20, retryMaxMs: 20 })(spec({ action: "markRead", processExisting: true }), (x) => got.push(x));
    m.add("1");
    await until(() => m.calls.includes("markRead 1"));
    await tick(150);
    expect(got).toHaveLength(1);
    stop();
  });
});

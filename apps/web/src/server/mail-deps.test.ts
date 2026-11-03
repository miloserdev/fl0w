import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Опрос почты (Mail Trigger) работает в процессе самого сервера Next, а библиотеки подгружаются динамически и скрыты от сборщика:
 * Node ищет их от каталога приложения, а не от пакета блоков. Поэтому они обязаны быть зависимостями apps/web
 * (иначе в логе: «Cannot find package 'imapflow'» и письма не приходят).
 */
describe("библиотеки почты видны серверу приложения", () => {
  const require = createRequire(import.meta.url);
  it.each(["imapflow", "nodemailer", "mailparser"])("%s", (name) => {
    expect(() => require.resolve(name)).not.toThrow();
  });
});

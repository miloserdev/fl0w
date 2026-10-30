import type { Json } from "@fl0w/schema";

/**
 * Секреты (токены ботов и т.п.) не хранятся во флоу открытым текстом: параметр может ссылаться на
 * переменную окружения СЕРВЕРА — `env:FL0W_SECRET_<ИМЯ>`. Читаются только переменные с этим префиксом,
 * поэтому флоу не может добраться до `PATH`, `HOME` и прочего окружения процесса.
 */
export const SECRET_ENV_PREFIX = "FL0W_SECRET_";
const SECRET_REF = /^env:(FL0W_SECRET_[A-Z0-9_]{1,64})$/;

/** Значение секрета. Пусто — берётся `defaultEnv` (имя переменной); иначе ссылка `env:…` или литерал. */
export function resolveSecret(raw: Json | undefined, defaultEnv?: string): string {
  let s = String(raw ?? "").trim();
  if (s === "" && defaultEnv) s = `env:${defaultEnv}`;
  if (s === "") throw new Error(`Secret is not set: enter it or reference a server variable like env:${SECRET_ENV_PREFIX}NAME`);
  if (!s.startsWith("env:")) return s;
  const m = SECRET_REF.exec(s);
  if (!m) throw new Error(`Only server variables named ${SECRET_ENV_PREFIX}… can be referenced (got "${s}")`);
  const value = process.env[m[1]!];
  if (!value) throw new Error(`Secret ${m[1]} is not set on the server`);
  return value;
}

/** Убирает секреты из текста (сообщения об ошибках не должны их раскрывать). */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

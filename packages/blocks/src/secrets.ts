import type { Json } from "@fl0w/schema";

/**
 * Secrets (bot tokens and the like) are not stored in a flow as plain text: a parameter can refer to
 * a SERVER environment variable: `env:FL0W_SECRET_<NAME>`. Only variables with this prefix are read,
 * so a flow cannot reach `PATH`, `HOME` or the rest of the process environment.
 */
export const SECRET_ENV_PREFIX = "FL0W_SECRET_";
const SECRET_REF = /^env:(FL0W_SECRET_[A-Z0-9_]{1,64})$/;

/** The secret value. Empty means `defaultEnv` (a variable name) is used; otherwise an `env:...` reference or a literal. */
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

/** Strips secrets from text (error messages must not reveal them). */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

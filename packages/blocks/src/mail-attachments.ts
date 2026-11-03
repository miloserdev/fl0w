import type { Json } from "@fl0w/schema";
import { filesBaseDir, resolveInside } from "./sandbox";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL, MAX_ATTACHMENTS, type MailAttachment } from "./mail-types";

/** Безопасное имя файла/папки: без путей, управляющих символов и ведущих точек. */
export function safeName(name: string, fallback: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[.\s]+/, "").trim().slice(0, 120);
  return cleaned === "" ? fallback : cleaned;
}

/**
 * Сохраняет вложения письма внутри каталога файлов: `<dir>/<id письма>/<имя>`. Выход за каталог невозможен (`resolveInside`),
 * имена очищаются, одинаковые получают суффикс, число и размер ограничены. Возвращает метаданные и путь (относительно каталога файлов).
 */
export async function saveAttachments(dir: string, messageId: string, items: MailAttachment[]): Promise<Json[]> {
  if (items.length > MAX_ATTACHMENTS) throw new Error(`Mail: too many attachments (${items.length}, max ${MAX_ATTACHMENTS})`);
  let total = 0;
  for (const a of items) {
    if (a.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Mail: attachment "${a.filename}" is larger than ${MAX_ATTACHMENT_BYTES} bytes`);
    total += a.bytes.byteLength;
  }
  if (total > MAX_ATTACHMENT_TOTAL) throw new Error(`Mail: attachments are larger than ${MAX_ATTACHMENT_TOTAL} bytes in total`);
  if (items.length === 0) return [];

  const fs = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:fs/promises");
  const base = await filesBaseDir();
  const folder = [safeName(dir, "mail"), safeName(messageId, "message")].join("/");
  const root = await resolveInside(base, folder);
  await fs.mkdir(root, { recursive: true });
  const used = new Set<string>();
  const out: Json[] = [];
  for (const a of items) {
    let name = safeName(a.filename, "attachment");
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      for (let n = 2; used.has(name); n++) name = `${stem} (${n})${ext}`;
    }
    used.add(name);
    const rel = `${folder}/${name}`;
    await fs.writeFile(await resolveInside(base, rel), a.bytes);
    out.push({ filename: a.filename, contentType: a.contentType, size: a.size, path: rel });
  }
  return out;
}

/**
 * Дописывает `path` к метаданным вложений письма. Сопоставление — по имени, по порядку: одноимённые вложения получают свои файлы
 * («a.txt», «a (2).txt»); вложения, которых нет среди сохранённых (вложенные письма, ссылки), остаются без `path`.
 */
export function withAttachmentPaths(meta: Json[], saved: Json[]): Json[] {
  const queues = new Map<Json, Json[]>();
  for (const f of saved) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) continue;
    const q = queues.get(f["filename"]!) ?? [];
    q.push(f["path"]!);
    queues.set(f["filename"]!, q);
  }
  return meta.map((a) => {
    if (a === null || typeof a !== "object" || Array.isArray(a)) return a;
    const path = queues.get(a["filename"]!)?.shift();
    return path === undefined ? a : { ...a, path };
  });
}

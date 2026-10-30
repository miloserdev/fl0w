/** Предел тела запроса вебхука. */
const MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLarge extends Error {}

/** Читает тело с жёстким пределом — не доверяя Content-Length. */
export async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new PayloadTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new PayloadTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}


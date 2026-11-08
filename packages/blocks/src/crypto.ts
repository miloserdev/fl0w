import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, type RunContext } from "./block";
import { textOf, valueOf, withOutputField } from "./value-io";

const ALGORITHMS = ["md5", "sha1", "sha256", "sha384", "sha512"];
const ENCODINGS = ["hex", "base64", "base64url"] as const;
const ACTIONS = ["hash", "hmac", "generate", "encrypt", "decrypt"] as const;
const MAX_RANDOM_BYTES = 1024;
const VERSION = "v1";

/**
 * Crypto: hash, hmac, generate (uuid / random bytes), encrypt and decrypt (AES-256-GCM by passphrase).
 * Secrets are set in the parameters: the MVP has no credential store.
 */
export class Crypto extends Block {
  static type = "crypto";
  static label = "Crypto";
  static icon = "key-round";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    {
      name: "action",
      type: "enum",
      required: true,
      default: "hash",
      options: ACTIONS.map((value) => ({ value })),
    },
    // text or a "{{ field }}" template; empty means the input itself
    { name: "value", type: "string", default: "" },
    {
      name: "algorithm",
      type: "enum",
      default: "sha256",
      options: ALGORITHMS.map((value) => ({ value })),
    },
    {
      name: "encoding",
      type: "enum",
      default: "hex",
      options: ENCODINGS.map((value) => ({ value })),
    },
    // hmac: the key; encrypt/decrypt: the passphrase
    { name: "secret", type: "string", default: "" },
    {
      name: "kind",
      type: "enum",
      default: "uuid",
      options: [{ value: "uuid" }, { value: "bytes" }],
    },
    { name: "length", type: "number", default: 16, min: 1, max: MAX_RANDOM_BYTES },
    { name: "field", type: "string", default: "value" },
    { name: "includeInput", type: "boolean", default: false },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>, ctx?: RunContext) {
    // node-only API: only inside the body of run
    const nodeCrypto = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:crypto");
    // scrypt runs in the thread pool, not `scryptSync`: heavy key derivation does not block the event loop and honours run cancellation
    const derive = (pass: string, salt: Buffer, signal?: AbortSignal): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("Aborted"));
        nodeCrypto.scrypt(pass, salt, 32, (err, key) => (err ? reject(err) : signal?.aborted ? reject(new Error("Aborted")) : resolve(key)));
      });
    const input = inputs["in0"];
    const action = String(params["action"] ?? "hash");
    const algorithm = String(params["algorithm"] ?? "sha256");
    const encoding = String(params["encoding"] ?? "hex") as (typeof ENCODINGS)[number];
    const secret = String(params["secret"] ?? "");
    const text = () => textOf(valueOf(input, params["value"]));
    if (!ENCODINGS.includes(encoding)) throw new Error(`Unknown encoding "${encoding}"`);
    if (["hash", "hmac"].includes(action) && !ALGORITHMS.includes(algorithm)) {
      throw new Error(`Unknown algorithm "${algorithm}"`);
    }

    let result: string;
    switch (action) {
      case "hash":
        result = nodeCrypto.createHash(algorithm).update(text()).digest(encoding);
        break;
      case "hmac":
        if (secret === "") throw new Error('Crypto: "secret" is required for hmac');
        result = nodeCrypto.createHmac(algorithm, secret).update(text()).digest(encoding);
        break;
      case "generate": {
        const n = Math.floor(Number(params["length"] ?? 16));
        if (!(n >= 1 && n <= MAX_RANDOM_BYTES)) throw new Error(`Length must be between 1 and ${MAX_RANDOM_BYTES}`);
        result = params["kind"] === "bytes" ? nodeCrypto.randomBytes(n).toString(encoding) : nodeCrypto.randomUUID();
        break;
      }
      case "encrypt": {
        if (secret === "") throw new Error('Crypto: "secret" (passphrase) is required to encrypt');
        const salt = nodeCrypto.randomBytes(16);
        const iv = nodeCrypto.randomBytes(12);
        const cipher = nodeCrypto.createCipheriv("aes-256-gcm", await derive(secret, salt, ctx?.signal), iv);
        const body = Buffer.concat([cipher.update(text(), "utf8"), cipher.final()]);
        result = [VERSION, salt, iv, cipher.getAuthTag(), body].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
        break;
      }
      case "decrypt": {
        if (secret === "") throw new Error('Crypto: "secret" (passphrase) is required to decrypt');
        const [version, salt, iv, tag, body] = text().split(".");
        if (version !== VERSION || !salt || !iv || !tag || body === undefined) throw new Error("Crypto: not an encrypted value");
        try {
          const decipher = nodeCrypto.createDecipheriv(
            "aes-256-gcm",
            await derive(secret, Buffer.from(salt, "base64url"), ctx?.signal),
            Buffer.from(iv, "base64url"),
          );
          decipher.setAuthTag(Buffer.from(tag, "base64url"));
          result = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
        } catch (e) {
          throw new Error("Crypto: wrong passphrase or corrupted value", { cause: e });
        }
        break;
      }
      default:
        throw new Error(`Unknown action "${action}"`);
    }
    return { out0: withOutputField(input, params, result, "value") };
  }
}

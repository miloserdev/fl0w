import type { Json, ParamSchema } from "@fl0w/schema";
import { Block } from "./block";
import { isPlainObject, resolveTemplates } from "./json-path";
import { textOf, valueOf } from "./value-io";

const ALGS = { HS256: "sha256", HS384: "sha384", HS512: "sha512" } as const;
type Alg = keyof typeof ALGS;

/** JWT (HMAC): sign, verify, decode. Секрет задаётся в параметрах. verify проверяет подпись, алгоритм, exp и nbf. */
export class Jwt extends Block {
  static type = "jwt";
  static label = "JWT";
  static icon = "badge-check";
  static category = "data";
  static ports = { inputs: [{ id: "in0" }], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    {
      name: "operation",
      type: "enum",
      required: true,
      default: "sign",
      options: [{ value: "sign" }, { value: "verify" }, { value: "decode" }],
    },
    { name: "secret", type: "string", default: "" },
    {
      name: "algorithm",
      type: "enum",
      default: "HS256",
      options: (Object.keys(ALGS) as Alg[]).map((value) => ({ value })),
    },
    // sign: claims; строки с «{{ путь }}» берут данные из входа
    { name: "payload", type: "json", default: {} },
    { name: "expiresInSeconds", type: "number", default: 0, min: 0 },
    // verify / decode: токен или шаблон; пусто — вход (строка или поле token)
    { name: "token", type: "string", default: "" },
  ];

  async run(inputs: Record<string, Json>, params: Record<string, Json>): Promise<Record<string, Json>> {
    const nodeCrypto = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "node:crypto");
    const input = inputs["in0"];
    const op = String(params["operation"] ?? "sign");
    const alg = String(params["algorithm"] ?? "HS256") as Alg;
    if (!(alg in ALGS)) throw new Error(`Unsupported algorithm "${alg}"`);
    const secret = String(params["secret"] ?? "");

    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const sign = (data: string) => nodeCrypto.createHmac(ALGS[alg], secret).update(data).digest("base64url");

    if (op === "sign") {
      if (secret === "") throw new Error('JWT: "secret" is required');
      const claims = resolveTemplates(params["payload"] ?? {}, input);
      if (!isPlainObject(claims)) throw new Error('JWT: "payload" must be an object');
      const iat = typeof claims["iat"] === "number" ? claims["iat"] : Math.floor(Date.now() / 1000);
      const ttl = Number(params["expiresInSeconds"] ?? 0);
      const body = { ...claims, iat, ...(ttl > 0 && claims["exp"] === undefined ? { exp: iat + ttl } : {}) };
      const head = `${b64(JSON.stringify({ alg, typ: "JWT" }))}.${b64(JSON.stringify(body))}`;
      return { out0: { token: `${head}.${sign(head)}` } };
    }

    let token = valueOf(isPlainObject(input) && typeof input["token"] === "string" ? input["token"] : input, params["token"]);
    token = textOf(token).trim();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("JWT: malformed token");
    const decodePart = (p: string): { [key: string]: Json } => {
      try {
        const v = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Json;
        if (!isPlainObject(v)) throw new Error("not an object");
        return v;
      } catch (e) {
        throw new Error("JWT: malformed token", { cause: e });
      }
    };
    const header = decodePart(parts[0]!);
    const payload = decodePart(parts[1]!);
    if (op === "decode") return { out0: { header, payload } };
    if (op !== "verify") throw new Error(`Unknown operation "${op}"`);

    if (secret === "") throw new Error('JWT: "secret" is required');
    if (header["alg"] !== alg) throw new Error(`JWT: algorithm mismatch (token uses ${String(header["alg"])})`);
    const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
    const actual = Buffer.from(parts[2]!);
    if (expected.length !== actual.length || !nodeCrypto.timingSafeEqual(expected, actual)) {
      throw new Error("JWT: invalid signature");
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload["exp"] === "number" && payload["exp"] <= now) throw new Error("JWT: token expired");
    if (typeof payload["nbf"] === "number" && payload["nbf"] > now) throw new Error("JWT: token not active yet");
    return { out0: { valid: true, header, payload } };
  }
}

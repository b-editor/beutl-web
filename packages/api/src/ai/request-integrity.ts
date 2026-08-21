import { z } from "zod";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/u);

export type AiRequestIdentity = {
  idempotencyKeyHash: string;
  requestFingerprint: string;
  // モデルを名指ししていない依頼を、以前は「そのとき解決された既定モデル入り」で
  // 指紋化していた。入れ替え配備の最中は両方の形の job が並ぶので、古い形も同じ
  // 依頼として認める。突き合わせる相手は、記録されている job のモデル——今の
  // 既定ではない。既定が入れ替わったあとや、そのモデルが止められたあとでも、
  // 支払い済みの job に届かなくなってはならない。新しく作る job は必ず上の形で
  // 記録される。
  legacyRequestFingerprintFor?: (modelId: string) => Promise<string>;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(
  value: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("AI request fingerprint values must be serializable");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

// Server Actions carry no request headers the caller controls, so the web forms
// send their key as a field. Both entry points must derive the fingerprint the
// same way or the same submission would reserve twice depending on how it came in.
export async function toAiRequestIdentity({
  idempotencyKey,
  operation,
  input,
}: {
  idempotencyKey: unknown;
  operation: string;
  input: unknown;
}): Promise<AiRequestIdentity | null> {
  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!key.success) return null;

  const named = typeof input === "object" && input !== null &&
    (input as Record<string, unknown>).model !== undefined;
  const [idempotencyKeyHash, requestFingerprint] = await Promise.all([
    sha256Hex(key.data),
    sha256Hex(canonicalJson({ operation, input })),
  ]);
  return {
    idempotencyKeyHash,
    requestFingerprint,
    ...(named ? {} : {
      legacyRequestFingerprintFor: (modelId: string) =>
        sha256Hex(
          canonicalJson({
            operation,
            input: { ...(input as Record<string, unknown>), model: modelId },
          }),
        ),
    }),
  };
}

export async function getAiRequestIdentity({
  request,
  operation,
  input,
}: {
  request: Request;
  operation: string;
  input: unknown;
}): Promise<AiRequestIdentity | null> {
  return await toAiRequestIdentity({
    idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
    operation,
    input,
  });
}

// リクエストが名乗った名前のハッシュ。指紋は要らない——「その名前の job が
// 既にあるか」を、本文を読む前に確かめるためだけのもの。
export async function getAiIdempotencyKeyHash(
  request: Request,
): Promise<string | null> {
  const key = idempotencyKeySchema.safeParse(
    request.headers.get(IDEMPOTENCY_KEY_HEADER),
  );
  return key.success ? await sha256Hex(key.data) : null;
}

export async function createCallbackNonce(): Promise<{
  nonce: string;
  hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = bytesToHex(bytes);
  return { nonce, hash: await sha256Hex(nonce) };
}

export async function callbackNonceMatches(
  nonce: string,
  expectedHash: string | null | undefined,
): Promise<boolean> {
  if (!expectedHash || !/^[0-9a-f]{64}$/iu.test(expectedHash)) return false;
  const actualHash = await sha256Hex(nonce);
  const actual = new TextEncoder().encode(actualHash);
  const expected = new TextEncoder().encode(expectedHash);
  if (actual.byteLength !== expected.byteLength) return false;

  let difference = 0;
  for (let index = 0; index < actual.byteLength; index++) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}

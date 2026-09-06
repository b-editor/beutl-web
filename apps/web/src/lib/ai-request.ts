import { INTERNAL_REQUEST_HEADERS } from "./internal-request";

export type AiRequestOutcome<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; errorCode: string };

const MAX_AI_REQUEST_RESPONSE_BYTES = 64 * 1024;

/**
 * Sends one of the video requests whose first response is ordinary JSON.
 *
 * The caller owns cancellation. In particular, an abort is allowed to reject
 * this promise instead of being mistaken for an API refusal: a video request
 * may have reached the API even when its response did not reach the browser.
 */
export async function runAiRequest<TResult>(
  operation: "videos" | "videos/frames",
  {
    body,
    idempotencyKey,
    signal,
  }: {
    body: BodyInit;
    idempotencyKey: string;
    signal?: AbortSignal;
  },
): Promise<AiRequestOutcome<TResult>> {
  const headers = new Headers({
    accept: "application/json",
    "Idempotency-Key": idempotencyKey,
    ...INTERNAL_REQUEST_HEADERS,
  });
  // FormData needs the browser-generated boundary. A string is the JSON form
  // used by the frame-free endpoint.
  if (typeof body === "string") headers.set("content-type", "application/json");

  const response = await fetch(`/api/internal/ai/${operation}`, {
    method: "POST",
    headers,
    body,
    ...(signal ? { signal } : {}),
  });
  const parsed = await boundedJsonOf(response, signal);
  if (!parsed.ok) return { ok: false, errorCode: "aiRequestInterrupted" };

  if (!response.ok) {
    const errorCode = errorCodeIn(parsed.value);
    // The video API uses aiProviderError only after a definite failure was
    // refunded. Any other 5xx can have happened after reservation or provider
    // acceptance, so treating it as terminal would discard the only key that
    // can recover the paid job.
    if (response.status >= 500 && errorCode !== "aiProviderError") {
      return { ok: false, errorCode: "aiRequestInterrupted" };
    }
    return {
      ok: false,
      errorCode: errorCode ?? "aiRequestInterrupted",
    };
  }
  return { ok: true, result: parsed.value as TResult };
}

function errorCodeIn(value: unknown): string | null {
  const errorCode = typeof value === "object" &&
    value !== null &&
    "error_code" in value &&
    typeof (value as { error_code: unknown }).error_code === "string"
    ? (value as { error_code: string }).error_code
    : null;
  return errorCode ? errorCode : null;
}

async function boundedJsonOf(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declaredText = response.headers.get("content-length");
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (
      Number.isSafeInteger(declared) &&
      declared >= 0 &&
      declared > MAX_AI_REQUEST_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
  }

  if (!response.body) return { ok: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_AI_REQUEST_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch (error) {
    // Only the caller's own abort remains exceptional. Other truncation/read
    // failures leave the request outcome unknown, just like malformed JSON.
    if (signal?.aborted) throw error;
    return { ok: false };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

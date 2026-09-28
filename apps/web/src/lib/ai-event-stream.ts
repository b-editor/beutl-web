import { INTERNAL_REQUEST_HEADERS } from "./internal-request";
import { isApiErrorCode, type ApiErrorCode } from "@beutl/core";

// Reading an AI answer as it arrives.
//
// The screens post to the dashboard's own path, which hands the request to the
// AI API with the session's user attached. What comes back is either an
// ordinary JSON refusal — a request the API will not serve, decided before any
// work starts — or a stream that ends in the answer.

export type AiStreamOutcome<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; errorCode: string };

export type AiStreamHandlers = {
  /** Called for every event before the closing one. */
  onEvent: (event: string, data: unknown) => void;
};

const EVENT_SEPARATOR = /\r?\n\r?\n/;
const REFUNDED_PROVIDER_ERRORS: ReadonlySet<ApiErrorCode> = new Set([
  "aiProviderError", "aiProviderBillingUnavailable",
]);

export async function runAiStream<TResult>(
  operation: "translations" | "images",
  {
    body,
    idempotencyKey,
    signal,
    onEvent,
  }: {
    body: BodyInit;
    idempotencyKey: string;
    signal?: AbortSignal;
  } & AiStreamHandlers,
): Promise<AiStreamOutcome<TResult>> {
  const headers = new Headers({
    accept: "text/event-stream",
    "Idempotency-Key": idempotencyKey,
    ...INTERNAL_REQUEST_HEADERS,
  });
  // A form's own encoding is set by the browser, boundary and all; anything
  // else here is JSON.
  if (typeof body === "string") headers.set("content-type", "application/json");

  const response = await fetch(`/api/internal/ai/${operation}`, {
    method: "POST",
    headers,
    body,
    ...(signal ? { signal } : {}),
  });

  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    // A completed idempotent request is replayed as ordinary JSON, even when
    // this caller requested a stream.
    if (response.ok) {
      try {
        return { ok: true, result: await response.json() as TResult };
      } catch {
        // The job succeeded, but its replay did not arrive intact. Keep the
        // request recoverable under the same idempotency key.
        return { ok: false, errorCode: "aiRequestInterrupted" };
      }
    }
    return { ok: false, errorCode: await errorCodeOf(response) };
  }
  if (!response.body) return { ok: false, errorCode: "aiRequestInterrupted" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        return { ok: false, errorCode: "aiRequestInterrupted" };
      }
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });

      let separator = EVENT_SEPARATOR.exec(buffer);
      while (separator) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const parsed = parseEvent(block);
        if (parsed) {
          // The server emits these only after persistence or failure handling.
          // A subsequent socket close must not overturn a settled result.
          if (parsed.event === "result") {
            return { ok: true, result: parsed.data as TResult };
          } else if (parsed.event === "error") {
            const code = errorCodeIn(parsed.data);
            return {
              ok: false,
              errorCode: code && REFUNDED_PROVIDER_ERRORS.has(code) ? code : "aiRequestInterrupted",
            };
          } else {
            onEvent(parsed.event, parsed.data);
          }
        }
        separator = EVENT_SEPARATOR.exec(buffer);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  // A stream always ends in one or the other; one that does not was cut off,
  // and the operation it was carrying may well have finished and been charged
  // for, which the job history is the place to settle.
  return { ok: false, errorCode: "aiRequestInterrupted" };
}

function parseEvent(block: string): { event: string; data: unknown } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    // A comment keeps the connection alive and says nothing.
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
  }
  if (!event || data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

function errorCodeIn(data: unknown): ApiErrorCode | null {
  const code = typeof data === "object" &&
    data !== null &&
    "error_code" in data
    ? data.error_code
    : null;
  return isApiErrorCode(code) ? code : null;
}

async function errorCodeOf(response: Response): Promise<string> {
  try {
    const code = errorCodeIn(await response.json());
    // Only these provider failures prove that a reservation was refunded.
    // Infrastructure failures may hide an already-paid job or its replay.
    if (code === null || code === "unknown" ||
      (response.status >= 500 && !REFUNDED_PROVIDER_ERRORS.has(code))) {
      return "aiRequestInterrupted";
    }
    return code;
  } catch {
    return "aiRequestInterrupted";
  }
}

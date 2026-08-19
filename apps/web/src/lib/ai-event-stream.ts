// Reading an AI answer as it arrives.
//
// The screens post to the dashboard's own path, which hands the request to the
// AI API with the session's user attached. What comes back is either an
// ordinary JSON refusal — a request the API will not serve, decided before any
// work starts — or a stream that ends in the answer.

// The header the dashboard's own requests carry, and the reason the route they
// go to cannot be driven from another site: a cross-site form cannot set a
// header, and a cross-site fetch that sets one is preflighted.
export const AI_STREAM_HEADER = "x-beutl-ai-stream";

export type AiStreamOutcome<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; errorCode: string };

export type AiStreamHandlers = {
  /** Called for every event before the closing one. */
  onEvent: (event: string, data: unknown) => void;
};

const EVENT_SEPARATOR = /\r?\n\r?\n/;

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
    [AI_STREAM_HEADER]: "1",
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
    return { ok: false, errorCode: await errorCodeOf(response) };
  }
  if (!response.body) return { ok: false, errorCode: "aiProviderError" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: AiStreamOutcome<TResult> | null = null;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });

    let separator = EVENT_SEPARATOR.exec(buffer);
    while (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const parsed = parseEvent(block);
      if (parsed) {
        if (parsed.event === "result") {
          outcome = { ok: true, result: parsed.data as TResult };
        } else if (parsed.event === "error") {
          outcome = { ok: false, errorCode: errorCodeIn(parsed.data) };
        } else {
          onEvent(parsed.event, parsed.data);
        }
      }
      separator = EVENT_SEPARATOR.exec(buffer);
    }
  }

  // A stream always ends in one or the other; one that does not was cut off,
  // and the operation it was carrying may well have finished and been charged
  // for, which the job history is the place to settle.
  return outcome ?? { ok: false, errorCode: "aiRequestInterrupted" };
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

function errorCodeIn(data: unknown): string {
  return typeof data === "object" &&
    data !== null &&
    "error_code" in data &&
    typeof (data as { error_code: unknown }).error_code === "string"
    ? (data as { error_code: string }).error_code
    : "aiProviderError";
}

async function errorCodeOf(response: Response): Promise<string> {
  try {
    return errorCodeIn(await response.json());
  } catch {
    return "aiProviderError";
  }
}

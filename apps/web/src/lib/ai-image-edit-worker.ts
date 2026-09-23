import { issueAiApiToken } from "./ai-api-token";
import { readJsonWithLimit } from "./internal-request";

const MAX_RESPONSE_BYTES = 64 * 1024;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/u;

type AiApiFetcher = { fetch(request: Request): Promise<Response> };

export type AiImageEditWorkerOutcome =
  | {
      ok: true;
      jobId: string;
      url: string;
      fileName: string | null;
      contentType: string | null;
    }
  | {
      ok: false;
      errorCode: string;
      keepIdempotencyKey: boolean;
    };

function interrupted(): AiImageEditWorkerOutcome {
  // The API Worker may have reserved and completed the job even when the Web
  // Worker lost its small JSON response. Keep the key so a retry collects it.
  return { ok: false, errorCode: "aiRequestInterrupted", keepIdempotencyKey: true };
}

/**
 * Run a Gateway image edit in the separate API Worker. The Web Server Action
 * keeps the form and its idempotency key, but never holds the provider's base64
 * image response inside the much larger OpenNext Worker isolate.
 */
export async function forwardImageEditToAiApiWorker({
  worker,
  userId,
  origin,
  formData,
}: {
  worker: AiApiFetcher;
  userId: string;
  origin: string;
  formData: FormData;
}): Promise<AiImageEditWorkerOutcome> {
  const key = formData.get("idempotencyKey");
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
    return { ok: false, errorCode: "invalidRequestBody", keepIdempotencyKey: false };
  }

  const token = await issueAiApiToken(userId);
  const request = new Request(new URL("/api/v3/ai/images/edit", origin), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: formData,
  });
  let response: Response;
  try {
    response = await worker.fetch(request);
  } catch {
    return interrupted();
  }

  let parsed: Awaited<ReturnType<typeof readJsonWithLimit>>;
  try {
    parsed = await readJsonWithLimit(response, MAX_RESPONSE_BYTES);
  } catch {
    return interrupted();
  }
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    return interrupted();
  }
  const data = parsed.value as Record<string, unknown>;
  if (response.ok) {
    if (typeof data.jobId !== "string" || typeof data.url !== "string") {
      return interrupted();
    }
    return {
      ok: true,
      jobId: data.jobId,
      url: data.url,
      fileName: typeof data.fileName === "string" ? data.fileName : null,
      contentType: typeof data.contentType === "string" ? data.contentType : null,
    };
  }

  const errorCode = typeof data.error_code === "string" ? data.error_code : null;
  if (!errorCode ||
    (response.status >= 500 && errorCode !== "aiProviderError" &&
      errorCode !== "aiProviderBillingUnavailable")) {
    return interrupted();
  }
  return {
    ok: false,
    errorCode,
    keepIdempotencyKey: errorCode === "aiRequestInProgress" ||
      errorCode === "aiRequestChanged" ||
      errorCode === "aiResultUnavailable",
  };
}

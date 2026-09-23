import { runAiRequest, type AiRequestOutcome } from "./ai-request";

export type AiImageEditRequestOutcome =
  | {
      ok: true;
      jobId: string;
      url: string;
      fileName: string | null;
      contentType: string | null;
    }
  | { ok: false; errorCode: string; keepIdempotencyKey: boolean };

function interrupted(): AiImageEditRequestOutcome {
  // The provider may have finished even if the JSON response was lost. A
  // retry must use the same key to collect the stored result without billing
  // another edit.
  return { ok: false, errorCode: "aiRequestInterrupted", keepIdempotencyKey: true };
}

export async function submitAiImageEdit(
  body: FormData,
  idempotencyKey: string,
): Promise<AiImageEditRequestOutcome> {
  let outcome: AiRequestOutcome<unknown>;
  try {
    outcome = await runAiRequest<unknown>("images/edit", { body, idempotencyKey });
  } catch {
    return interrupted();
  }

  if (!outcome.ok) {
    const errorCode = outcome.errorCode;
    return {
      ok: false,
      errorCode,
      keepIdempotencyKey: errorCode === "aiRequestInterrupted" ||
        errorCode === "aiRequestInProgress" ||
        errorCode === "aiRequestChanged" ||
        errorCode === "aiResultUnavailable",
    };
  }

  const value = outcome.result;
  if (typeof value !== "object" || value === null) return interrupted();
  const data = value as Record<string, unknown>;
  if (typeof data.jobId !== "string" || !data.jobId ||
    typeof data.url !== "string" || !data.url) return interrupted();
  return {
    ok: true,
    jobId: data.jobId,
    url: data.url,
    fileName: typeof data.fileName === "string" ? data.fileName : null,
    contentType: typeof data.contentType === "string" ? data.contentType : null,
  };
}

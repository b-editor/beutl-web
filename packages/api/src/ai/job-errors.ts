import { aiProviderFailureCode, type AiProviderError } from "./providers/errors";

export const AI_JOB_FAILURE_MESSAGES = {
  imageGeneration: "AI image generation failed",
  imageEdit: "AI image editing failed",
  transcription: "AI transcription failed",
  translation: "AI translation failed",
  videoSubmission: "AI video submission failed",
  videoGeneration: "AI video generation failed",
  providerBilling: "AI provider billing refusal",
} as const;

export const PUBLIC_AI_JOB_ERROR = "aiProviderError";

/** Log only bounded classifications, never a provider body, prompt, or uploaded media. */
export function reportAiProviderFailure({
  operation,
  jobId,
  provider,
  model,
  error,
}: {
  operation: string;
  jobId: string;
  provider: string;
  model: string;
  error: AiProviderError;
}): void {
  console.warn("AI provider request failed", {
    operation,
    jobId,
    provider,
    model,
    errorType: error.name,
    httpStatus: error.httpStatus,
    execution: error.execution,
  });
}

/** Persist only a fixed classification, never a provider response or key ID. */
export function aiJobFailureMessage(cause: unknown, fallback: string): string {
  return aiProviderFailureCode(cause) === "aiProviderBillingUnavailable"
    ? AI_JOB_FAILURE_MESSAGES.providerBilling
    : fallback;
}

export function publicAiJobError(error: string | null | undefined):
  "aiProviderError" | "aiProviderBillingUnavailable" {
  return error === AI_JOB_FAILURE_MESSAGES.providerBilling
    ? "aiProviderBillingUnavailable"
    : PUBLIC_AI_JOB_ERROR;
}

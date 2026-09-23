import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  AiVideoSubmissionError,
  aiProviderFailureCode,
} from "../../packages/api/src/ai/providers/errors";
import { AI_JOB_FAILURE_MESSAGES, aiJobFailureMessage, publicAiJobError } from "../../packages/api/src/ai/job-errors";

describe("provider billing refusal", () => {
  it("recognizes a definite Gateway 402 without relying on the SDK error name", () => {
    const error = new AiVideoSubmissionError("sensitive upstream billing detail", {
      outcome: "definite_failure",
      httpStatus: 402,
      cause: { name: "GatewayInternalServerError" },
    });
    expect(error.httpStatus).toBe(402);
    expect(error.execution).toBe("definite_failure");
    expect(aiProviderFailureCode(error)).toBe("aiProviderBillingUnavailable");
  });

  it("does not turn unrelated provider failures into billing errors", () => {
    expect(aiProviderFailureCode(new AiProviderError("bad input", { httpStatus: 400 })))
      .toBe("aiProviderError");
    expect(aiProviderFailureCode(new Error("storage failed"))).toBe("aiProviderError");
  });

  it("stores only a safe billing classification for later idempotent replay", () => {
    const raw = "sensitive upstream billing detail";
    const stored = aiJobFailureMessage(
      new AiProviderError(raw, { httpStatus: 402 }),
      AI_JOB_FAILURE_MESSAGES.videoSubmission,
    );
    expect(stored).toBe(AI_JOB_FAILURE_MESSAGES.providerBilling);
    expect(stored).not.toContain(raw);
    expect(publicAiJobError(stored)).toBe("aiProviderBillingUnavailable");
    expect(publicAiJobError(AI_JOB_FAILURE_MESSAGES.videoSubmission)).toBe("aiProviderError");
  });
});

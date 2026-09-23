import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  AiVideoSubmissionError,
  aiProviderFailureCode,
} from "../../packages/api/src/ai/providers/errors";

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
});

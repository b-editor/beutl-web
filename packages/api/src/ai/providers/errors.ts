// The errors every AI provider reports failures through.
//
// These used to live in ./openrouter, which made the one provider that existed
// also the owner of the vocabulary every other part of the service reasons
// about. A second provider cannot import OpenRouter's client just to throw, so
// they live here; ./openrouter re-exports them and keeps its own imports valid.
//
// `execution` is the field the money depends on. A reservation is refunded only
// when the provider is certainly not working on something the user has paid
// for; "unknown" means the request may have been accepted and the job must stay
// queued. Every provider adapter classifies its own transport and status codes
// into this axis — see `AiProvider.executionOf`.

export type AiExecutionOutcome = "definite_failure" | "unknown";

export class AiProviderError extends Error {
  readonly httpStatus: number | null;
  readonly execution: AiExecutionOutcome;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      httpStatus?: number;
      execution?: AiExecutionOutcome;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiProviderError";
    this.httpStatus = options?.httpStatus ?? null;
    this.execution = options?.execution ?? "definite_failure";
  }
}

/** A 402 belongs to the upstream provider, never to the Beutl account. */
export function aiProviderFailureCode(
  error: unknown,
): "aiProviderBillingUnavailable" | "aiProviderError" {
  return error instanceof AiProviderError && error.httpStatus === 402
    ? "aiProviderBillingUnavailable"
    : "aiProviderError";
}

export class InvalidAiProviderOutputError extends AiProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, execution: "definite_failure" });
    this.name = "InvalidAiProviderOutputError";
  }
}

export function isProviderExecutionOutcomeUnknown(
  error: unknown,
): error is AiProviderError {
  return error instanceof AiProviderError && error.execution === "unknown";
}

export type AiVideoSubmissionOutcome = AiExecutionOutcome;

export class AiVideoSubmissionError extends AiProviderError {
  readonly outcome: AiVideoSubmissionOutcome;

  constructor(
    message: string,
    options: {
      outcome: AiVideoSubmissionOutcome;
      cause?: unknown;
      httpStatus?: number;
    },
  ) {
    // `outcome` and `execution` are the same axis under two names, and the
    // base class reads only the second. Passing `options` straight through
    // left every unknown submission carrying execution: "definite_failure" —
    // harmless only for as long as the refund path keeps reading `outcome`.
    super(message, { ...options, execution: options.outcome });
    this.name = "AiVideoSubmissionError";
    this.outcome = options.outcome;
  }
}

export function isDefiniteVideoSubmissionFailure(
  error: unknown,
): error is AiVideoSubmissionError {
  return (
    error instanceof AiVideoSubmissionError &&
    error.outcome === "definite_failure"
  );
}

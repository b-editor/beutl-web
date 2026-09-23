// Turning a Gateway failure into something the refund logic can act on.
//
// `execution` is the field the money depends on. "unknown" keeps the job
// queued and paid for; "definite_failure" refunds it. The costly mistake is
// calling an accepted submission a definite failure — the user is refunded
// while the provider bills us for work nobody collects — so anything that could
// have reached a model is unknown, and the reconciler refunds it once the
// provider's job window has passed.

import { GatewayError } from "@ai-sdk/gateway";
import { AiProviderError, type AiExecutionOutcome } from "../errors";

/**
 * 4XX means the Gateway refused before dispatching, except:
 *   408 — a timeout says nothing about what happened at the other end.
 *   409 — a conflict on an idempotent start means a job may already exist.
 */
export function gatewayExecutionOf(cause: unknown): AiExecutionOutcome {
  if (cause instanceof GatewayError) {
    const status = cause.statusCode;
    if (status === 408 || status === 409) return "unknown";
    if (status >= 400 && status < 500) return "definite_failure";
    return "unknown";
  }
  if (cause instanceof AiProviderError) return cause.execution;
  // A transport error, an abort, or anything unrecognized: the request may
  // have been received.
  return "unknown";
}

/** The SDK normalizes unknown Gateway error types to internal_server_error.
 * Recover only the bounded machine-readable type from its API response; the
 * response message can contain account, billing, or credential details.
 */
export function gatewayResponseErrorType(cause: unknown): string | null {
  if (!(cause instanceof GatewayError)) return null;
  const apiError = cause.cause;
  if (typeof apiError !== "object" || apiError === null) return null;
  const record = apiError as Record<string, unknown>;
  const raw = record.data ?? record.responseBody;
  let response: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 4096) return null;
    try {
      response = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof response !== "object" || response === null) return null;
  const error = (response as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return null;
  const type = (error as Record<string, unknown>).type;
  return typeof type === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(type)
    ? type
    : null;
}

function gatewayMessage(cause: unknown, fallback: string): string {
  if (cause instanceof GatewayError) {
    return `${fallback}: ${cause.statusCode} ${cause.message}`;
  }
  if (cause instanceof Error) return `${fallback}: ${cause.message}`;
  return fallback;
}

export function toGatewayProviderError(
  cause: unknown,
  fallback: string,
): AiProviderError {
  if (cause instanceof AiProviderError) return cause;
  return new AiProviderError(gatewayMessage(cause, fallback), {
    cause,
    execution: gatewayExecutionOf(cause),
    ...(cause instanceof GatewayError ? { httpStatus: cause.statusCode } : {}),
  });
}

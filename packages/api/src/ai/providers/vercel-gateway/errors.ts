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

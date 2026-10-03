// Stripe errors are recognised by shape rather than by class, so that a Stripe
// SDK loaded from another package (or a test double) is recognised the same way.

export function isStripeResourceMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404 &&
    "code" in error &&
    error.code === "resource_missing"
  );
}

// Stripe rejected the request itself (an unknown or malformed id, a resource
// in another account, an object in the wrong state). Connection, rate-limit,
// authentication, and server errors are not this, and say nothing about the
// request that was sent.
export function isStripeInvalidRequestError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "StripeInvalidRequestError"
  );
}

export function isStripeChargeAlreadyRefundedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "charge_already_refunded"
  );
}

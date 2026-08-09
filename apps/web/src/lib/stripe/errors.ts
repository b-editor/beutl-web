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

export function isStripeChargeAlreadyRefundedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "charge_already_refunded"
  );
}

import type { PackageCheckoutCompletionStatus } from "./status";

export const PACKAGE_CHECKOUT_POLL_INTERVAL_MS = 2_000;
export const PACKAGE_CHECKOUT_POLL_TIMEOUT_MS = 30_000;

export function shouldPollPackageCheckoutCompletionStatus(
  status: PackageCheckoutCompletionStatus,
): boolean {
  return status === "processing";
}

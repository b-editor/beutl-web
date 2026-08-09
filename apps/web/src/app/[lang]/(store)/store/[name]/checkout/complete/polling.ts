import type { PackageCheckoutCompletionStatus } from "./status";

export const PACKAGE_CHECKOUT_POLL_INITIAL_INTERVAL_MS = 1_000;
export const PACKAGE_CHECKOUT_POLL_MAX_INTERVAL_MS = 8_000;
export const PACKAGE_CHECKOUT_POLL_TIMEOUT_MS = 30_000;

export function nextPackageCheckoutPollInterval(interval: number): number {
  return Math.min(interval * 2, PACKAGE_CHECKOUT_POLL_MAX_INTERVAL_MS);
}

export function shouldPollPackageCheckoutCompletionStatus(
  status: PackageCheckoutCompletionStatus,
): boolean {
  return status === "processing";
}

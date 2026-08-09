"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  nextPackageCheckoutPollInterval,
  PACKAGE_CHECKOUT_POLL_INITIAL_INTERVAL_MS,
  PACKAGE_CHECKOUT_POLL_TIMEOUT_MS,
  shouldPollPackageCheckoutCompletionStatus,
} from "./polling";
import type { PackageCheckoutCompletionStatus } from "./status";

export function CompletionStatusPoller({
  status,
}: {
  status: PackageCheckoutCompletionStatus;
}) {
  const router = useRouter();
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!shouldPollPackageCheckoutCompletionStatus(status)) {
      startedAtRef.current = null;
      return;
    }

    const startedAt = startedAtRef.current ?? Date.now();
    startedAtRef.current = startedAt;
    let interval = PACKAGE_CHECKOUT_POLL_INITIAL_INTERVAL_MS;
    let timeoutId: number;
    const poll = () => {
      if (Date.now() - startedAt >= PACKAGE_CHECKOUT_POLL_TIMEOUT_MS) {
        return;
      }
      router.refresh();
      interval = nextPackageCheckoutPollInterval(interval);
      timeoutId = window.setTimeout(poll, interval);
    };

    timeoutId = window.setTimeout(poll, interval);
    return () => window.clearTimeout(timeoutId);
  }, [router, status]);

  return null;
}

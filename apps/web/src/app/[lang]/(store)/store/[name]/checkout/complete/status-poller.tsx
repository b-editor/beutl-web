"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  PACKAGE_CHECKOUT_POLL_INTERVAL_MS,
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
    let timeoutId: number;
    const poll = () => {
      if (Date.now() - startedAt >= PACKAGE_CHECKOUT_POLL_TIMEOUT_MS) {
        return;
      }
      router.refresh();
      timeoutId = window.setTimeout(poll, PACKAGE_CHECKOUT_POLL_INTERVAL_MS);
    };

    timeoutId = window.setTimeout(poll, PACKAGE_CHECKOUT_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [router, status]);

  return null;
}

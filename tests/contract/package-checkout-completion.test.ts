import { describe, expect, it } from "vitest";
import { PACKAGE_PAYMENT_EVENT_RANK } from "@beutl/db";
import {
  resolvePackageCheckoutCompletionStatus,
} from "../../apps/web/src/app/[lang]/(store)/store/[name]/checkout/complete/status";
import {
  nextPackageCheckoutPollInterval,
  shouldPollPackageCheckoutCompletionStatus,
} from "../../apps/web/src/app/[lang]/(store)/store/[name]/checkout/complete/polling";

const activePayment = {
  paymentId: "pi_1",
  userId: "user-1",
  packageId: "package-1",
  fulfillmentValidated: true,
  revokedAt: null,
  stripeStateEventRank: PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
};

describe("package checkout completion status", () => {
  it("shows success only for validated active fulfillment", () => {
    expect(
      resolvePackageCheckoutCompletionStatus("succeeded", activePayment),
    ).toBe("succeeded");
    expect(resolvePackageCheckoutCompletionStatus("succeeded", null)).toBe(
      "processing",
    );
  });

  it("shows a completed refund instead of payment success", () => {
    expect(
      resolvePackageCheckoutCompletionStatus("succeeded", {
        ...activePayment,
        fulfillmentValidated: false,
        revokedAt: new Date("2026-08-09T00:01:00.000Z"),
        stripeStateEventRank: PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
      }),
    ).toBe("refunded");
  });

  it("shows a dispute revocation as a terminal unavailable state", () => {
    expect(
      resolvePackageCheckoutCompletionStatus("succeeded", {
        ...activePayment,
        revokedAt: new Date("2026-08-09T00:01:00.000Z"),
        stripeStateEventRank: PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      }),
    ).toBe("revoked");
    expect(shouldPollPackageCheckoutCompletionStatus("revoked")).toBe(false);
  });

  it("polls only while webhook fulfillment is still processing", () => {
    expect(shouldPollPackageCheckoutCompletionStatus("processing")).toBe(true);
    expect(shouldPollPackageCheckoutCompletionStatus("succeeded")).toBe(false);
    expect(shouldPollPackageCheckoutCompletionStatus("refunded")).toBe(false);
  });

  it("keeps other Stripe statuses unchanged", () => {
    expect(
      resolvePackageCheckoutCompletionStatus("requires_payment_method", null),
    ).toBe("requires_payment_method");
  });

  it("backs polling off to the configured maximum", () => {
    expect(nextPackageCheckoutPollInterval(1_000)).toBe(2_000);
    expect(nextPackageCheckoutPollInterval(4_000)).toBe(8_000);
    expect(nextPackageCheckoutPollInterval(8_000)).toBe(8_000);
  });
});

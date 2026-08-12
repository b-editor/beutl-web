import { describe, expect, it } from "vitest";
import { packagePaymentReversalTranslationKey } from "../../apps/web/src/lib/billing-history";

describe("billing history presentation", () => {
  it("labels revoked package payments without hiding the money-in record", () => {
    expect(packagePaymentReversalTranslationKey({
      revokedAt: new Date("2026-08-11T00:00:00.000Z"),
    })).toBe("account:billing.packagePurchaseReversed");
  });

  it("leaves active package payments unmarked", () => {
    expect(packagePaymentReversalTranslationKey({ revokedAt: null })).toBeNull();
  });
});

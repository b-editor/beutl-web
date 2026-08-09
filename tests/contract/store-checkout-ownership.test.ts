import { describe, expect, it } from "vitest";
import {
  isOwnedPackagePaymentIntent,
  packagePaymentIntentMetadata,
  packagePaymentIntentSearchQuery,
} from "../../apps/web/src/lib/stripe/store-checkout";

describe("store checkout ownership", () => {
  it("binds package PaymentIntents to the application and user", () => {
    expect(packagePaymentIntentMetadata("user-1", "package-1")).toEqual({
      beutlApplication: "beutl-web",
      beutlPurchaseKind: "package",
      beutlUserId: "user-1",
      packageId: "package-1",
    });
    expect(
      packagePaymentIntentSearchQuery({
        customerId: "cus_1",
        userId: "user-1",
        packageId: "package-1",
        amount: 1_000,
        currency: "USD",
      }),
    ).toContain('metadata["beutlUserId"]:"user-1"');
  });

  it("accepts only an exact customer, owner, package, and price match", () => {
    const paymentIntent = {
      amount: 1_000,
      currency: "usd",
      customer: "cus_1",
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
    };
    const expected = {
      customerId: "cus_1",
      userId: "user-1",
      packageId: "package-1",
      amount: 1_000,
      currency: "USD",
    };

    expect(
      isOwnedPackagePaymentIntent(paymentIntent as never, expected),
    ).toBe(true);
    expect(
      isOwnedPackagePaymentIntent(paymentIntent as never, {
        ...expected,
        userId: "another-user",
      }),
    ).toBe(false);
    expect(
      isOwnedPackagePaymentIntent(paymentIntent as never, {
        ...expected,
        amount: 999,
      }),
    ).toBe(false);
  });

  it("rejects legacy intents without ownership metadata", () => {
    expect(
      isOwnedPackagePaymentIntent(
        {
          amount: 1_000,
          currency: "usd",
          customer: "cus_1",
          metadata: { packageId: "package-1" },
        } as never,
        {
          customerId: "cus_1",
          userId: "user-1",
          packageId: "package-1",
        },
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  isOwnedPackageCheckoutSession,
  isOwnedPackagePaymentIntent,
  packagePaymentIntentMetadata,
} from "../../apps/web/src/lib/stripe/store-checkout";

const EXPECTED = {
  customerId: "cus_1",
  userId: "user-1",
  packageId: "package-1",
  amount: 1_000,
  currency: "USD",
};

describe("store checkout ownership", () => {
  it("binds package purchases to the application and user", () => {
    expect(packagePaymentIntentMetadata("user-1", "package-1")).toEqual({
      beutlApplication: "beutl-web",
      beutlPurchaseKind: "package",
      beutlUserId: "user-1",
      packageId: "package-1",
    });
  });

  it("accepts only an exact customer, owner, package, and price match", () => {
    const paymentIntent = {
      amount: 1_000,
      currency: "usd",
      customer: "cus_1",
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
    };

    expect(
      isOwnedPackagePaymentIntent(paymentIntent as never, EXPECTED),
    ).toBe(true);
    expect(
      isOwnedPackagePaymentIntent(paymentIntent as never, {
        ...EXPECTED,
        userId: "another-user",
      }),
    ).toBe(false);
    expect(
      isOwnedPackagePaymentIntent(paymentIntent as never, {
        ...EXPECTED,
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

  it("reuses only an open Checkout Session for the same purchase", () => {
    const checkoutSession = {
      mode: "payment",
      amount_total: 1_000,
      currency: "usd",
      customer: "cus_1",
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
    };

    expect(
      isOwnedPackageCheckoutSession(checkoutSession as never, EXPECTED),
    ).toBe(true);
    expect(
      isOwnedPackageCheckoutSession(
        { ...checkoutSession, amount_total: 1_200 } as never,
        EXPECTED,
      ),
    ).toBe(false);
    expect(
      isOwnedPackageCheckoutSession(
        { ...checkoutSession, mode: "subscription" } as never,
        EXPECTED,
      ),
    ).toBe(false);
    expect(
      isOwnedPackageCheckoutSession(checkoutSession as never, {
        ...EXPECTED,
        packageId: "package-2",
      }),
    ).toBe(false);
  });

  it("checks ownership without a price when the completion page returns", () => {
    const checkoutSession = {
      mode: "payment",
      amount_total: 1_000,
      currency: "usd",
      customer: "cus_1",
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
    };

    expect(
      isOwnedPackageCheckoutSession(checkoutSession as never, {
        customerId: "cus_1",
        userId: "user-1",
        packageId: "package-1",
      }),
    ).toBe(true);
  });
});

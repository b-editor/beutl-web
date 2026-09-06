import { describe, expect, it } from "vitest";
import {
  isOwnedPackageCheckoutCandidate,
  classifyPackageCheckoutCompletion,
  isOwnedPackageCheckoutSession,
  isOwnedPackagePaymentIntent,
  isDurablyAssociatedPackageCheckoutSession,
  matchesPersistedPackageCheckoutSession,
  PACKAGE_CHECKOUT_SESSION_EXACT_EXPANDS,
  packageCheckoutFingerprintInput,
  shouldReuseBoundPackageCheckoutSession,
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

  it("classifies only this package's owned payment Session for expiry", () => {
    const base = {
      mode: "payment",
      customer: "cus_1",
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
    };
    expect(isOwnedPackageCheckoutCandidate(base, EXPECTED)).toBe(true);
    expect(isOwnedPackageCheckoutCandidate({
      ...base,
      metadata: packagePaymentIntentMetadata("user-1", "package-2"),
    }, EXPECTED)).toBe(false);
    expect(isOwnedPackageCheckoutCandidate({
      ...base,
      mode: "subscription",
    }, EXPECTED)).toBe(false);
    expect(isOwnedPackageCheckoutCandidate({
      ...base,
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        beutlPurchaseKind: "top_up",
        packageId: "package-1",
      },
    }, EXPECTED)).toBe(false);
  });

  it("canonicalizes the complete Checkout params with a version", () => {
    const first = packageCheckoutFingerprintInput({
      mode: "payment",
      customer: "cus_1",
      metadata: { z: "2", a: "1" },
      line_items: [],
    } as never);
    const second = packageCheckoutFingerprintInput({
      line_items: [],
      metadata: { a: "1", z: "2" },
      customer: "cus_1",
      mode: "payment",
    } as never);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toContain("package-checkout-v2");
    expect(packageCheckoutFingerprintInput({
      mode: "payment",
      customer: "cus_1",
      metadata: { a: "changed" },
      line_items: [],
    } as never)).not.toEqual(first);
  });

  it("keeps complete pending/active payments on the completion URL", () => {
    expect(classifyPackageCheckoutCompletion({
      checkoutSession: { status: "complete" },
      paymentIntent: { status: "succeeded" },
      paymentRecord: null,
    })).toBe("complete-pending");
    expect(classifyPackageCheckoutCompletion({
      checkoutSession: { status: "complete" },
      paymentIntent: { status: "processing" },
      paymentRecord: { revokedAt: null },
    })).toBe("complete-pending");
    expect(classifyPackageCheckoutCompletion({
      checkoutSession: { status: "complete" },
      paymentIntent: { status: "succeeded" },
      paymentRecord: { revokedAt: new Date() },
    })).toBe("rotate-terminal");
  });

  it("does not reuse a bound Session when fingerprint or locale differs", () => {
    const session = {
      id: "cs_1",
      status: "open",
      mode: "payment",
      amount_total: 1_000,
      currency: "usd",
      customer: "cus_1",
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
      success_url: "https://example.test/en/store/pkg/checkout/complete",
    };
    expect(shouldReuseBoundPackageCheckoutSession({
      attemptFingerprint: "same", currentFingerprint: "same", checkoutSession: session,
      expected: EXPECTED, lang: "en", packageName: "pkg",
    })).toBe(true);
    expect(shouldReuseBoundPackageCheckoutSession({
      attemptFingerprint: "old", currentFingerprint: "new", checkoutSession: session,
      expected: EXPECTED, lang: "en", packageName: "pkg",
    })).toBe(false);
  });

  it("does not bind a legacy Session from partial price or metadata matches", () => {
    const legacy = {
      mode: "payment",
      amount_total: EXPECTED.amount,
      currency: EXPECTED.currency,
      customer: EXPECTED.customerId,
      metadata: packagePaymentIntentMetadata(EXPECTED.userId, EXPECTED.packageId),
      success_url: "https://example.test/en/store/pkg/checkout/complete",
    };
    expect(isOwnedPackageCheckoutSession(legacy, EXPECTED)).toBe(true);
    expect(isDurablyAssociatedPackageCheckoutSession(legacy, "attempt-1")).toBe(false);
    expect(isDurablyAssociatedPackageCheckoutSession({
      metadata: { ...legacy.metadata, packageCheckoutAttemptId: "attempt-1" },
    }, "attempt-1")).toBe(true);
  });

  it("accepts an exact bound pre-token Session for reuse", () => {
    const params = {
      mode: "payment",
      customer: "cus_1",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 1_000,
          product_data: { name: "Package", description: "A package", images: [] },
        },
      }],
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
      payment_intent_data: { metadata: packagePaymentIntentMetadata("user-1", "package-1") },
      invoice_creation: { enabled: true },
      success_url: "https://example.test/en/store/pkg/checkout/complete",
      cancel_url: "https://example.test/en/store/pkg",
    };
    const session = {
      status: "open",
      mode: "payment",
      customer: "cus_1",
      metadata: params.metadata,
      success_url: params.success_url,
      cancel_url: params.cancel_url,
      amount_total: 1_000,
      currency: "usd",
      line_items: {
        data: [{
          quantity: 1,
          price: {
            product: { name: "Package", description: "A package", images: [] },
          },
        }],
      },
      invoice_creation: { enabled: true },
    } as never;
    const intent = { customer: "cus_1", amount: 1_000, currency: "usd", metadata: params.payment_intent_data.metadata } as never;
    expect(matchesPersistedPackageCheckoutSession(session, params as never, intent)).toBe(true);
  });

  it("expands the retained Price Product when validating a bound Session", () => {
    expect(PACKAGE_CHECKOUT_SESSION_EXACT_EXPANDS).toEqual(["line_items.data.price.product", "payment_intent"]);
  });

  it("fails closed when invoice creation or PaymentIntent setup usage differs", () => {
    const params = {
      mode: "payment", customer: "cus_1",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1_000, product_data: { name: "Package" } } }],
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
      payment_intent_data: { setup_future_usage: "off_session", metadata: packagePaymentIntentMetadata("user-1", "package-1") },
      invoice_creation: { enabled: true }, success_url: "https://example.test/success", cancel_url: "https://example.test/cancel",
    };
    const session = {
      status: "complete", mode: "payment", customer: "cus_1", metadata: params.metadata,
      success_url: params.success_url, cancel_url: params.cancel_url, amount_total: 1_000, currency: "usd",
      invoice_creation: { enabled: false }, line_items: { data: [{ quantity: 1, price: { product: { name: "Package" } } }] },
    };
    const intent = { customer: "cus_1", amount: 1_000, currency: "usd", setup_future_usage: "off_session", metadata: params.payment_intent_data.metadata };
    expect(matchesPersistedPackageCheckoutSession(session as never, params as never, intent as never)).toBe(false);
    expect(matchesPersistedPackageCheckoutSession({ ...session, invoice_creation: { enabled: true } } as never, params as never, { ...intent, setup_future_usage: null } as never)).toBe(false);
  });

  it("fails closed for bound Session ownership or persisted-parameter mismatches", () => {
    const params = {
      mode: "payment",
      customer: "cus_1",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1_000, product_data: { name: "Package" } } }],
      metadata: packagePaymentIntentMetadata("user-1", "package-1"),
      payment_intent_data: { metadata: packagePaymentIntentMetadata("user-1", "package-1") },
      success_url: "https://example.test/success",
      cancel_url: "https://example.test/cancel",
    } as never;
    const session = {
      status: "open", mode: "payment", customer: "cus_other", metadata: params.metadata,
      success_url: params.success_url, cancel_url: params.cancel_url, amount_total: 1_000, currency: "usd",
      line_items: { data: [{ quantity: 1, price: { product: { name: "Package" } } }] },
    } as never;
    expect(matchesPersistedPackageCheckoutSession(session, params as never, { metadata: params.payment_intent_data.metadata } as never)).toBe(false);
    expect(matchesPersistedPackageCheckoutSession({ ...session, customer: "cus_1", amount_total: 999 } as never, params as never, { metadata: params.payment_intent_data.metadata } as never)).toBe(false);
  });

  it("keeps completed pending payments recoverable but terminalizes revoked or expired outcomes", () => {
    expect(classifyPackageCheckoutCompletion({ checkoutSession: { status: "complete" }, paymentIntent: { status: "succeeded" }, paymentRecord: null })).toBe("complete-pending");
    expect(classifyPackageCheckoutCompletion({ checkoutSession: { status: "complete" }, paymentIntent: { status: "succeeded" }, paymentRecord: { revokedAt: new Date() } })).toBe("rotate-terminal");
    expect(classifyPackageCheckoutCompletion({ checkoutSession: { status: "expired" }, paymentIntent: null, paymentRecord: null })).toBe("rotate-terminal");
  });

  it("does not turn an unbound legacy ambiguity into a durable binding", () => {
    const legacy = { metadata: packagePaymentIntentMetadata("user-1", "package-1") } as never;
    expect(isDurablyAssociatedPackageCheckoutSession(legacy, "attempt-1")).toBe(false);
  });
});

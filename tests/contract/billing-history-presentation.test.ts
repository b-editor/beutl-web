import { describe, expect, it } from "vitest";
import {
  buildBillingHistory,
  packagePaymentReversalTranslationKey,
} from "../../apps/web/src/lib/billing-history";

describe("billing history presentation", () => {
  it("labels revoked package payments without hiding the money-in record", () => {
    expect(packagePaymentReversalTranslationKey({
      revokedAt: new Date("2026-08-11T00:00:00.000Z"),
    })).toBe("account:billing.paymentReversed");
  });

  it("leaves active package payments unmarked", () => {
    expect(packagePaymentReversalTranslationKey({ revokedAt: null })).toBeNull();
  });
});

// Echoes the key back with its interpolation so assertions stay readable and the
// builder can be checked without loading i18next.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

const PACKAGE = {
  name: "package-x",
  displayName: "Package X",
  user: { name: "seller", Profile: { displayName: "Seller Name" } },
};

function packagePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "history-1",
    paymentId: "pi_package_1",
    packageId: "package-1",
    stripePaymentAmount: 500,
    stripeCurrency: "jpy",
    revokedAt: null,
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}

function creditPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: "credit-1",
    stripePaymentId: "pi_credit_1",
    creditAmount: 500,
    stripePaymentAmount: 1_000,
    stripeCurrency: "jpy",
    reversedCredits: 0,
    isFullyReversed: false,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

function subscriptionPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_1",
    product: "aiPro" as const,
    paidAt: new Date("2026-08-01T00:00:00.000Z"),
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-01T00:00:00.000Z"),
    amount: { value: 2_000, currency: "jpy" },
    refundedAmount: 0,
    disputed: false,
    document: { url: "https://invoice.stripe.com/in_1", kind: "invoice" as const },
    ...overrides,
  };
}

function build({
  subscriptionPayments = [],
  payments = [],
  creditPurchases = [],
  packages = [["package-1", PACKAGE]] as [string, typeof PACKAGE][],
  documents = [] as [string, { url: string; kind: "invoice" | "receipt" }][],
  lang = "ja",
}: {
  subscriptionPayments?: ReturnType<typeof subscriptionPayment>[];
  payments?: ReturnType<typeof packagePayment>[];
  creditPurchases?: ReturnType<typeof creditPurchase>[];
  packages?: [string, typeof PACKAGE][];
  documents?: [string, { url: string; kind: "invoice" | "receipt" }][];
  lang?: string;
} = {}) {
  return buildBillingHistory({
    subscriptionPayments,
    payments,
    creditPurchases,
    packagesById: new Map(packages),
    documentByPaymentIntentId: new Map(documents),
    t,
    lang,
  });
}

describe("buildBillingHistory", () => {
  it("merges subscription, package, and credit payments newest first", () => {
    const entries = build({
      subscriptionPayments: [subscriptionPayment()],
      payments: [packagePayment()],
      creditPurchases: [creditPurchase()],
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "credit",
      "subscription",
      "package",
    ]);
  });

  it("names a subscription payment by product and tier, with its period", () => {
    const [entry] = build({ subscriptionPayments: [subscriptionPayment()] });

    expect(entry.product).toBe(
      'account:billing.productTier:{"product":"account:billing.productName","tier":"account:billing.tierPro"}',
    );
    expect(entry.detail).toBe(
      'account:billing.subscriptionPeriod:{"start":"2026年8月1日","end":"2026年9月1日"}',
    );
    expect(entry.amount).toEqual({ value: 2_000, currency: "jpy" });
    expect(entry.document).toEqual({
      url: "https://invoice.stripe.com/in_1",
      kind: "invoice",
    });
  });

  it("marks a refunded or disputed subscription payment", () => {
    const [refunded] = build({
      subscriptionPayments: [subscriptionPayment({ refundedAmount: 2_000 })],
    });
    expect(refunded.reversalNote).toBe("account:billing.paymentReversed");

    const [disputed] = build({
      subscriptionPayments: [subscriptionPayment({ disputed: true })],
    });
    expect(disputed.reversalNote).toBe("account:billing.paymentReversed");
  });

  it("reports how much a partial subscription refund returned", () => {
    const [entry] = build({
      subscriptionPayments: [subscriptionPayment({ refundedAmount: 500 })],
    });

    expect(entry.reversalNote).toBe(
      'account:billing.paymentPartiallyRefunded:{"amount":"￥500"}',
    );
  });

  it("links each payment to the Stripe document recorded for its charge", () => {
    const entries = build({
      payments: [packagePayment()],
      creditPurchases: [creditPurchase()],
      documents: [
        ["pi_package_1", { url: "https://invoice.stripe.com/pkg", kind: "invoice" }],
        ["pi_credit_1", { url: "https://pay.stripe.com/receipts/credit", kind: "receipt" }],
      ],
    });

    expect(
      entries.map((entry) => [entry.kind, entry.document?.kind ?? null]),
    ).toEqual([
      ["credit", "receipt"],
      ["package", "invoice"],
    ]);
  });

  it("leaves the document empty when Stripe has none for the charge", () => {
    const [entry] = build({ payments: [packagePayment()] });

    expect(entry.document).toBeNull();
  });

  it("reads the package amount from the stored row instead of Stripe", () => {
    const [entry] = build({ payments: [packagePayment()] });

    expect(entry.amount).toEqual({ value: 500, currency: "jpy" });
    expect(entry.product).toBe("Package X");
    expect(entry.detail).toBe("Seller Name");
  });

  it("reports no amount for a payment written before amount capture", () => {
    const [entry] = build({
      payments: [
        packagePayment({ stripePaymentAmount: null, stripeCurrency: null }),
      ],
    });

    expect(entry.amount).toBeNull();
  });

  it("calls a payment whose package is gone a removed item", () => {
    const [entry] = build({ payments: [packagePayment()], packages: [] });

    expect(entry.product).toBe("account:billing.unknownPackage");
    expect(entry.detail).toBe("account:billing.unknownSeller");
  });

  it("falls back to the package name when it has no display name", () => {
    const [entry] = build({
      payments: [packagePayment()],
      packages: [
        [
          "package-1",
          { ...PACKAGE, displayName: null, user: { name: "seller", Profile: null } },
        ],
      ],
    });

    expect(entry.product).toBe("package-x");
    expect(entry.detail).toBe("seller");
  });

  it("marks a revoked package payment", () => {
    const [entry] = build({
      payments: [
        packagePayment({ revokedAt: new Date("2026-07-05T00:00:00.000Z") }),
      ],
    });

    expect(entry.reversalNote).toBe("account:billing.paymentReversed");
  });

  it("shows the purchased credit count alongside the charge", () => {
    const [entry] = build({ creditPurchases: [creditPurchase()] });

    expect(entry.product).toBe("account:billing.creditPurchase");
    expect(entry.detail).toBe(
      'account:billing.creditPurchaseAmount:{"credits":"500"}',
    );
    expect(entry.amount).toEqual({ value: 1_000, currency: "jpy" });
  });

  it("marks a fully refunded credit purchase", () => {
    const [entry] = build({
      creditPurchases: [
        creditPurchase({ reversedCredits: 500, isFullyReversed: true }),
      ],
    });

    expect(entry.reversalNote).toBe("account:billing.creditPurchaseRefunded");
  });

  it("reports how many credits a partial refund reversed", () => {
    const [entry] = build({
      creditPurchases: [creditPurchase({ reversedCredits: 1_200 })],
    });

    expect(entry.reversalNote).toBe(
      'account:billing.creditPurchasePartiallyRefunded:{"credits":"1,200"}',
    );
  });

  it("keeps a credit purchase with no recorded Stripe charge, without an amount", () => {
    // The row is still a receipt for credits the user holds. Dropping it hides
    // the purchase entirely; the package branch renders the same state as an
    // em dash, and this follows it.
    const [entry] = build({
      creditPurchases: [
        creditPurchase({ stripePaymentAmount: null, stripeCurrency: null }),
      ],
    });

    expect(entry).toMatchObject({ kind: "credit", amount: null });
  });

  it("returns an empty list when the user has never paid", () => {
    expect(build()).toEqual([]);
  });
});

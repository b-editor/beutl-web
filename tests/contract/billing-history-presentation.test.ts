import { describe, expect, it } from "vitest";
import {
  buildBillingHistory,
  packagePaymentReversalTranslationKey,
} from "../../apps/web/src/lib/billing-history";

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
    creditAmount: 500,
    stripePaymentAmount: 1_000,
    stripeCurrency: "jpy",
    reversedCredits: 0,
    isFullyReversed: false,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

function build({
  payments = [],
  creditPurchases = [],
  packages = [["package-1", PACKAGE]] as [string, typeof PACKAGE][],
  lang = "ja",
}: {
  payments?: ReturnType<typeof packagePayment>[];
  creditPurchases?: ReturnType<typeof creditPurchase>[];
  packages?: [string, typeof PACKAGE][];
  lang?: string;
} = {}) {
  return buildBillingHistory({
    payments,
    creditPurchases,
    packagesById: new Map(packages),
    t,
    lang,
  });
}

describe("buildBillingHistory", () => {
  it("merges package purchases and credit top-ups newest first", () => {
    const entries = build({
      payments: [packagePayment()],
      creditPurchases: [creditPurchase()],
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["credit", "package"]);
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

    expect(entry.reversalNote).toBe("account:billing.packagePurchaseReversed");
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

  it("skips a credit purchase with no recorded Stripe charge", () => {
    expect(
      build({
        creditPurchases: [
          creditPurchase({ stripePaymentAmount: null, stripeCurrency: null }),
        ],
      }),
    ).toEqual([]);
  });

  it("returns an empty list when the user has never paid", () => {
    expect(build()).toEqual([]);
  });
});

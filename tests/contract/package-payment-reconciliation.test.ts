import { describe, expect, it } from "vitest";
import { classifyHistoricalPackagePayment } from "../../apps/web/scripts/reconcile-package-payments.mjs";

function classify(overrides: Record<string, unknown> = {}) {
  return classifyHistoricalPackagePayment({
    paymentIntent: { id: "pi_1", status: "succeeded" },
    refunds: [],
    disputes: [],
    ...overrides,
  });
}

describe("historical package payment reconciliation", () => {
  it("revokes any successfully refunded payment", () => {
    expect(
      classify({
        refunds: [
          { id: "re_failed", status: "failed", created: 20 },
          { id: "re_success", status: "succeeded", created: 10 },
        ],
      }),
    ).toMatchObject({
      rank: 40,
      sourceId: "re_success",
      sourceKind: "refund",
    });
  });

  it("revokes open and lost disputes but not won disputes", () => {
    expect(
      classify({
        disputes: [
          { id: "dp_open", status: "under_review", created: 10 },
        ],
      }),
    ).toMatchObject({ rank: 30, sourceId: "dp_open" });
    expect(
      classify({
        disputes: [{ id: "dp_lost", status: "lost", created: 10 }],
      }),
    ).toMatchObject({ rank: 30, sourceId: "dp_lost" });
    expect(
      classify({
        disputes: [{ id: "dp_won", status: "won", created: 10 }],
      }),
    ).toBeNull();
  });

  it("revokes a historical payment that is no longer succeeded", () => {
    expect(
      classify({
        paymentIntent: { id: "pi_1", status: "canceled" },
      }),
    ).toMatchObject({
      rank: 40,
      sourceId: "pi_1",
      sourceKind: "payment-intent",
    });
  });
});

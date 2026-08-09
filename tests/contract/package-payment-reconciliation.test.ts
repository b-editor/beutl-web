import { describe, expect, it } from "vitest";
import {
  classifyHistoricalPackagePayment,
  historicalStateEvent,
  isHistoricalStateEventNewer,
} from "../../apps/web/scripts/reconcile-package-payments.mjs";

function classify(overrides: Record<string, unknown> = {}) {
  return classifyHistoricalPackagePayment({
    paymentIntent: { id: "pi_1", status: "succeeded", created: 5 },
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
      sourceCreated: 10,
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
    ).toMatchObject({ rank: 20, sourceId: "dp_open" });
    expect(
      classify({
        disputes: [{ id: "dp_lost", status: "lost", created: 10 }],
      }),
    ).toMatchObject({ rank: 20, sourceId: "dp_lost" });
    expect(
      classify({
        disputes: [{ id: "dp_won", status: "won", created: 10 }],
      }),
    ).toBeNull();
  });

  it("revokes a historical payment that is no longer succeeded", () => {
    expect(
      classify({
        paymentIntent: { id: "pi_1", status: "canceled", created: 5 },
      }),
    ).toMatchObject({
      rank: 40,
      sourceId: "pi_1",
      sourceCreated: 5,
      sourceKind: "payment-intent",
    });
  });

  it("does not let a stale dispute dominate a concurrent restoration", () => {
    const candidate = classify({
      disputes: [{ id: "dp_open", status: "under_review", created: 10 }],
    });
    const incoming = historicalStateEvent(candidate);

    expect(
      isHistoricalStateEventNewer(
        {
          stripeStateEventId: "evt_dispute_won",
          stripeStateEventCreatedAt: new Date(11_000),
          stripeStateEventRank: 30,
        },
        incoming,
      ),
    ).toBe(false);
    expect(
      isHistoricalStateEventNewer(
        {
          stripeStateEventId: "evt_dispute_won",
          stripeStateEventCreatedAt: new Date(10_000),
          stripeStateEventRank: 30,
        },
        incoming,
      ),
    ).toBe(false);
  });

  it("does not overwrite a terminal refund with later dispute bookkeeping", () => {
    expect(
      isHistoricalStateEventNewer(
        {
          stripeStateEventId: "reconcile:re_success",
          stripeStateEventCreatedAt: new Date(10_000),
          stripeStateEventRank: 40,
        },
        {
          id: "reconcile:dp_open",
          createdAt: new Date(20_000),
          rank: 20,
        },
      ),
    ).toBe(false);
  });

  it("uses observation time for a terminal succeeded refund", () => {
    const candidate = classify({
      refunds: [{ id: "re_success", status: "succeeded", created: 10 }],
    });
    const observedAt = new Date("2026-08-09T00:03:00.000Z");

    expect(historicalStateEvent(candidate, observedAt)).toMatchObject({
      id: "reconcile:re_success",
      createdAt: observedAt,
      rank: 40,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { reconcileStripeCheckoutCleanups } from "../../packages/api/src/ai/stripe-checkout-cleanups";
import { reconcileTopUpDuplicateRefunds } from "../../packages/api/src/ai/topup-duplicate-refunds";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const dbMocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  claimCleanup: vi.fn(),
  claimPackageDetached: vi.fn(),
  claimPackageInterventions: vi.fn(),
  claimProDetached: vi.fn(),
  getPackageResolution: vi.fn(),
  packageResolutionState: vi.fn(),
  schedulePackageResolutionRefunds: vi.fn(),
  reschedulePackageIntervention: vi.fn(),
  finalizePackageResolution: vi.fn(),
  findPackagePaymentReference: vi.fn(),
}));

vi.mock("@beutl/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/db")>();
  return {
    ...actual,
    listDueStripeCheckoutCleanups: dbMocks.listDue,
    claimStripeCheckoutCleanup: dbMocks.claimCleanup,
    claimDetachedPackageCheckoutAttempt: dbMocks.claimPackageDetached,
    claimPackageCheckoutInterventions: dbMocks.claimPackageInterventions,
    claimDetachedProCheckoutAttempts: dbMocks.claimProDetached,
    getPackageCheckoutResolution: dbMocks.getPackageResolution,
    packageCheckoutResolutionRefundState: dbMocks.packageResolutionState,
    schedulePackageCheckoutResolutionRefunds: dbMocks.schedulePackageResolutionRefunds,
    reschedulePackageCheckoutIntervention: dbMocks.reschedulePackageIntervention,
    finalizePackageCheckoutResolution: dbMocks.finalizePackageResolution,
    findPackagePaymentReference: dbMocks.findPackagePaymentReference,
  };
});

const NOW = new Date("2026-08-25T00:00:00.000Z");

function session(
  id: string,
  paymentIntentId: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id,
    mode: "payment",
    status: "complete",
    customer: "cus_topup",
    amount_subtotal: 1000,
    amount_total: 1000,
    currency: "usd",
    payment_intent: paymentIntentId,
    metadata: {
      beutlApplication: "beutl-web",
      beutlUserId: "deleted-user",
      topUpAttemptId: "attempt-topup",
      billingOfferId: "offer-topup",
    },
    ...overrides,
  };
}

function seedAttempt(database: ReturnType<typeof createInMemoryPrisma>, overrides: Record<string, unknown> = {}) {
  database.state.billingOffers.set("offer-topup", {
    id: "offer-topup",
    kind: "top_up",
    stripePriceId: "price-topup",
    stripeProductId: "product-topup",
    unitAmount: 1000,
    currency: "usd",
    creditAmount: 500,
    recurringInterval: null,
    recurringIntervalCount: null,
    checkoutEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const attempt: any = {
    id: "attempt-topup",
    ownerUserId: "deleted-user",
    stripeCustomerId: "cus_topup",
    billingOfferId: "offer-topup",
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    status: "refund_required",
    expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    accountDeletionAt: NOW,
    paramsJson: null,
    recoveryLeaseToken: null,
    recoveryLeaseExpiresAt: null,
    recoveryAttempts: 0,
    recoveryLastError: null,
    recoveryNotBefore: null,
    recoveryInterventionAt: null,
    fulfilledAt: null,
    refundId: null,
    refundStatus: null,
    refundStatusObservedAt: null,
    refundTargetAmount: null,
    refundSucceededAmount: 0,
    refundPendingAmount: 0,
    refundCurrency: null,
    refundNotBefore: NOW,
    refundLeaseToken: null,
    refundLeaseExpiresAt: null,
    refundAttempts: 0,
    refundLastError: null,
    refundInterventionAt: null,
    createdAt: new Date("2026-08-24T23:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
  database.state.topUpCheckoutAttempts.set(attempt.id, attempt);
  return attempt;
}

function stripeFor(
  sessions: any[],
  chargeCreated: Record<string, number>,
  refunded = new Map<string, any[]>(),
  amount = 1000,
) {
  const ownerUserId = sessions[0]?.metadata?.beutlUserId ?? "deleted-user";
  const refundList = vi.fn(async ({ payment_intent: paymentIntentId, starting_after }: any) => {
    const rows = refunded.get(paymentIntentId) ?? [];
    return starting_after ? { data: [], has_more: false } : { data: rows, has_more: false };
  });
  const refundCreate = vi.fn(async ({ payment_intent: paymentIntentId, amount }: any) => {
    const row = { id: `re-${paymentIntentId}`, amount, status: "succeeded" };
    refunded.set(paymentIntentId, [row]);
    return row;
  });
  return {
    checkout: {
      sessions: {
        list: vi.fn(async ({ status }: any) => ({ data: status === "complete" ? sessions : [], has_more: false })),
        expire: vi.fn(),
        retrieve: vi.fn(),
      },
    },
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({
        id,
        status: "succeeded",
        amount,
        amount_received: amount,
        currency: "usd",
        customer: "cus_topup",
        metadata: { topUpAttemptId: "attempt-topup", beutlUserId: ownerUserId, billingOfferId: "offer-topup", creditAmount: "500" },
        latest_charge: { id: `ch-${id}`, created: chargeCreated[id] },
      })),
    },
    refunds: { list: refundList, create: refundCreate },
  } as any;
}

describe("top-up account-deletion recovery reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.listDue.mockResolvedValue([]);
    dbMocks.claimCleanup.mockResolvedValue(null);
    dbMocks.claimPackageDetached.mockResolvedValue([]);
    dbMocks.claimPackageInterventions.mockResolvedValue([]);
    dbMocks.claimProDetached.mockResolvedValue([]);
    dbMocks.getPackageResolution.mockResolvedValue({ status: "refund_pending", canonicalSessionId: null, revision: 0, evidenceJson: "[]" });
    dbMocks.packageResolutionState.mockResolvedValue("settled");
    dbMocks.schedulePackageResolutionRefunds.mockResolvedValue({});
    dbMocks.reschedulePackageIntervention.mockResolvedValue({ count: 1 });
    dbMocks.finalizePackageResolution.mockResolvedValue({ count: 1 });
    dbMocks.findPackagePaymentReference.mockResolvedValue(null);
  });

  it("CAS-terminalizes multiple already-expired Sessions", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database);
    const expired = ["cs-expired-a", "cs-expired-b"].map((id) => ({ ...session(id, "pi-unused"), status: "expired" }));
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({ data: status === "expired" ? expired : [], has_more: false })),
        expire: vi.fn(), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn(), create: vi.fn() },
    };
    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({ status: "refund_not_required", recoveryLeaseToken: null });
  });

  it("CAS-terminalizes open Sessions after every expire call returns expired", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database);
    const open = ["cs-open-a", "cs-open-b"].map((id) => ({ ...session(id, "pi-unused"), status: "open" }));
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({ data: status === "open" ? open : [], has_more: false })),
        expire: vi.fn(async (id: string) => ({ ...open.find((item) => item.id === id), status: "expired" })), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn(), create: vi.fn() },
    };
    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({ status: "refund_not_required", recoveryLeaseToken: null });
  });

  it("binds a normal recovered open Session without expiring or refunding it", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      ownerUserId: "active-user",
      accountDeletionAt: null,
      activeOwnerKey: "active-user",
      checkoutKey: "ai-top-up-checkout:attempt-topup",
      status: "open",
      refundNotBefore: null,
    });
    const open = {
      ...session("cs-normal-open", "pi-unused"),
      status: "open",
      metadata: {
        ...session("unused", "unused").metadata,
        beutlUserId: "active-user",
      },
    };
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({
          data: status === "open" ? [open] : [],
          has_more: false,
        })),
        expire: vi.fn(),
        retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn(), create: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({
      status: "open",
      stripeCheckoutSessionId: "cs-normal-open",
      activeOwnerKey: "active-user",
      recoveryLeaseToken: null,
      createLeaseToken: null,
    });
  });

  it("terminalizes a normal completed Session whose payment is already fully refunded", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      ownerUserId: "active-user",
      accountDeletionAt: null,
      activeOwnerKey: "active-user",
      checkoutKey: "ai-top-up-checkout:attempt-topup",
      status: "open",
      refundNotBefore: null,
    });
    const completed = {
      ...session("cs-normal-refunded", "pi-refunded"),
      metadata: {
        ...session("unused", "unused").metadata,
        beutlUserId: "active-user",
      },
    };
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({
          data: status === "complete" ? [completed] : [],
          has_more: false,
        })),
        expire: vi.fn(),
        retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn(async () => ({
        id: "pi-refunded",
        status: "succeeded",
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
        customer: "cus_topup",
        metadata: {
          topUpAttemptId: "attempt-topup",
          beutlUserId: "active-user",
          billingOfferId: "offer-topup",
          creditAmount: "500",
        },
        latest_charge: { id: "ch-refunded", created: 1 },
      })) },
      refunds: { list: vi.fn(async () => ({
        data: [{ id: "re-full", amount: 1000, currency: "usd", status: "succeeded" }],
        has_more: false,
      })), create: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({
      status: "expired",
      stripeCheckoutSessionId: null,
      activeOwnerKey: null,
    });
    expect(database.state.topUpCheckoutResolutions.size).toBe(0);
  });

  it("terminalizes a recovered zero-cost Session without a PaymentIntent", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      ownerUserId: "active-user",
      accountDeletionAt: null,
      activeOwnerKey: "active-user",
      checkoutKey: "ai-top-up-checkout:attempt-topup",
      status: "open",
      paramsJson: JSON.stringify({ allow_promotion_codes: true }),
      refundNotBefore: null,
    });
    const completed = session("cs-zero-cost", "unused", {
      payment_intent: null,
      amount_total: 0,
      metadata: {
        ...session("unused", "unused").metadata,
        beutlUserId: "active-user",
        creditAmount: "500",
      },
    });
    const retrievePaymentIntent = vi.fn();
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({
          data: status === "complete" ? [completed] : [],
          has_more: false,
        })),
        expire: vi.fn(),
        retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: retrievePaymentIntent },
      refunds: { list: vi.fn(), create: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(database.state.topUpCheckoutAttempts.get("attempt-topup"))
      .toMatchObject({ status: "expired", activeOwnerKey: null });
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("schedules only the remaining refund for a partially refunded normal Session", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      ownerUserId: "active-user",
      accountDeletionAt: null,
      activeOwnerKey: "active-user",
      checkoutKey: "ai-top-up-checkout:attempt-topup",
      status: "open",
      refundNotBefore: null,
    });
    const completed = {
      ...session("cs-normal-partial", "pi-partial"),
      metadata: {
        ...session("unused", "unused").metadata,
        beutlUserId: "active-user",
      },
    };
    const refunds = new Map<string, any[]>([["pi-partial", [{
      id: "re-partial",
      amount: 400,
      currency: "usd",
      status: "succeeded",
    }]]]);
    const stripe = stripeFor(
      [completed],
      { "pi-partial": 1 },
      refunds,
    );

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(database.state.topUpCheckoutResolutions.get("attempt-topup")).toMatchObject({
      canonicalSessionId: null,
      canonicalPaymentIntentId: null,
      expectedPaymentIntentIds: '["pi-partial"]',
      status: "refund_pending",
    });
    expect([...database.state.topUpDuplicateRefundAttempts.values()]).toEqual([
      expect.objectContaining({
        stripePaymentIntentId: "pi-partial",
        amount: 1000,
        status: "required",
      }),
    ]);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({
      stripeCheckoutSessionId: null,
      activeOwnerKey: "active-user",
      recoveryNotBefore: expect.any(Date),
    });
  });

  it.each([
    ["amount", { amount: 999, amount_received: 999 }],
    ["currency", { currency: "eur" }],
    ["credit metadata", { metadata: { creditAmount: "999" } }],
  ])("fails closed when canonical top-up %s differs from the BillingOffer", async (_case, paymentOverride) => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      ownerUserId: "active-user",
      accountDeletionAt: null,
      activeOwnerKey: "active-user",
      checkoutKey: "ai-top-up-checkout:attempt-topup",
      status: "open",
      refundNotBefore: null,
    });
    const completed = {
      ...session("cs-invalid-offer", "pi-invalid-offer"),
      metadata: {
        ...session("unused", "unused").metadata,
        beutlUserId: "active-user",
      },
    };
    const metadata = {
      topUpAttemptId: "attempt-topup",
      beutlUserId: "active-user",
      billingOfferId: "offer-topup",
      creditAmount: "500",
      ...((paymentOverride as any).metadata ?? {}),
    };
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({
          data: status === "complete" ? [completed] : [],
          has_more: false,
        })),
        expire: vi.fn(),
        retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn(async () => ({
        id: "pi-invalid-offer",
        status: "succeeded",
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
        customer: "cus_topup",
        metadata,
        latest_charge: { id: "ch-invalid", created: 1 },
        ...paymentOverride,
        metadata,
      })) },
      refunds: { list: vi.fn(async () => ({ data: [], has_more: false })), create: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({
      status: "open",
      stripeCheckoutSessionId: null,
      recoveryNotBefore: expect.any(Date),
    });
    expect(database.state.topUpCheckoutResolutions.size).toBe(0);
  });

  it("terminalizes a params-less normal legacy attempt after repeated exhaustive absence", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      ownerUserId: "active-user",
      accountDeletionAt: null,
      activeOwnerKey: "active-user",
      checkoutKey: "ai-top-up-checkout:attempt-topup",
      status: "open",
      refundNotBefore: null,
      createdAt: new Date(NOW.getTime() - 24 * 60 * 60_000 - 1),
    });
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async () => ({ data: [], has_more: false })),
        expire: vi.fn(),
        retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn(), create: vi.fn() },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    const confirmAt = new Date(NOW.getTime() + 5 * 60_000);
    await reconcileStripeCheckoutCleanups(confirmAt, "sk_test", stripe);

    expect(stripe.checkout.sessions.list).toHaveBeenCalledTimes(6);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({
      status: "expired",
      activeOwnerKey: null,
      recoveryLeaseToken: null,
    });
  });

  it("preserves an expire race that completes a Session", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database);
    const open = [
      { ...session("cs-race-complete", "pi-race"), status: "open" },
      { ...session("cs-race-expired", "pi-expired"), status: "open" },
    ];
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({ data: status === "open" ? open : [], has_more: false })),
        expire: vi.fn(async (id: string) => ({ ...open.find((item) => item.id === id), status: id === "cs-race-complete" ? "complete" : "expired" })), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn(), create: vi.fn() },
    };
    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({ status: "refund_required", stripeCheckoutSessionId: "cs-race-complete", recoveryLeaseToken: null });
  });

  it("retries when a multiple-session expiry race remains open", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database);
    const open = ["cs-stuck-a", "cs-stuck-b"].map((id) => ({ ...session(id, "pi-unused"), status: "open" }));
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({ data: status === "open" ? open : [], has_more: false })),
        expire: vi.fn(async () => { throw new Error("race"); }),
        retrieve: vi.fn(async (id: string) => ({ ...open.find((item) => item.id === id), status: "open" })),
      } },
      paymentIntents: { retrieve: vi.fn() },
      refunds: { list: vi.fn(), create: vi.fn() },
    };
    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({
      recoveryInterventionAt: null,
      recoveryLeaseToken: null,
      recoveryNotBefore: expect.any(Date),
      recoveryAttempts: 1,
    });
  });

  it("persists duplicate resolution, settles its outbox, and binds the canonical Session on the next claim tick", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database);
    const refunds = new Map<string, any[]>();
    const stripe = stripeFor([session("cs-a", "pi-a"), session("cs-b", "pi-b")], { "pi-a": 10, "pi-b": 20 }, refunds);

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    const resolution = database.state.topUpCheckoutResolutions.get("attempt-topup")!;
    const duplicate = [...database.state.topUpDuplicateRefundAttempts.values()];
    expect(resolution).toMatchObject({ status: "refund_pending", canonicalSessionId: "cs-a", expectedPaymentIntentIds: '["pi-b"]' });
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({ stripePaymentIntentId: "pi-b", status: "required" });
    duplicate[0]!.notBefore = NOW;

    await reconcileTopUpDuplicateRefunds(NOW, "sk_test", stripe);
    expect(database.state.topUpDuplicateRefundAttempts.get(duplicate[0]!.id)).toMatchObject({ status: "refunded", refundId: "re-pi-b", refundedAmount: 1000 });

    await reconcileStripeCheckoutCleanups(new Date(NOW.getTime() + 5 * 60_000), "sk_test", stripe);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({ status: "refund_required", stripeCheckoutSessionId: "cs-a", recoveryLeaseToken: null });
    expect(database.state.topUpCheckoutResolutions.get("attempt-topup")).toMatchObject({ status: "resolved", canonicalSessionId: "cs-a" });
  });

  it("hydrates promotion-code discounted Sessions at the charged amount", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, {
      paramsJson: JSON.stringify({ allow_promotion_codes: true }),
    });
    const discounted = [
      session("cs-discount-a", "pi-discount-a", { amount_total: 800 }),
      session("cs-discount-b", "pi-discount-b", { amount_total: 800 }),
    ];
    const stripe = stripeFor(
      discounted,
      { "pi-discount-a": 10, "pi-discount-b": 20 },
      new Map(),
      800,
    );

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(database.state.topUpCheckoutResolutions.get("attempt-topup"))
      .toMatchObject({ canonicalPaymentIntentId: "pi-discount-a" });
    expect([...database.state.topUpDuplicateRefundAttempts.values()]).toEqual([
      expect.objectContaining({
        stripePaymentIntentId: "pi-discount-b",
        amount: 800,
      }),
    ]);
  });

  it("hydrates legacy Sessions whose amount fields were not retained", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, { paramsJson: null });
    const historical = [
      session("cs-legacy-a", "pi-legacy-a", {
        amount_subtotal: null,
        amount_total: null,
      }),
      session("cs-legacy-b", "pi-legacy-b", {
        amount_subtotal: null,
        amount_total: null,
      }),
    ];
    const stripe = stripeFor(
      historical,
      { "pi-legacy-a": 10, "pi-legacy-b": 20 },
    );

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);

    expect(database.state.topUpCheckoutResolutions.get("attempt-topup"))
      .toMatchObject({ canonicalPaymentIntentId: "pi-legacy-a" });
    expect([...database.state.topUpDuplicateRefundAttempts.values()]).toEqual([
      expect.objectContaining({
        stripePaymentIntentId: "pi-legacy-b",
        amount: 1_000,
      }),
    ]);
  });

  it("prefers the attempt PaymentIntent as canonical even when another Charge is older", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database, { stripePaymentIntentId: "pi-b" });
    const stripe = stripeFor([session("cs-a", "pi-a"), session("cs-b", "pi-b")], { "pi-a": 10, "pi-b": 20 });

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(database.state.topUpCheckoutResolutions.get("attempt-topup")).toMatchObject({ canonicalSessionId: "cs-b", expectedPaymentIntentIds: '["pi-a"]' });
    expect([...database.state.topUpDuplicateRefundAttempts.values()].map((row) => row.stripePaymentIntentId)).toEqual(["pi-a"]);
  });

  it("atomically intervenes the resolution and attempt, then excludes it from the next claim", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    seedAttempt(database);
    database.state.topUpCheckoutResolutions.set("attempt-topup", {
      id: "resolution-1", topUpAttemptId: "attempt-topup", ownerUserId: "deleted-user", stripeCustomerId: "cus_topup", billingOfferId: "offer-topup", canonicalSessionId: "cs-a", expectedPaymentIntentIds: '["pi-b"]', status: "refund_pending", revision: 0, lastError: null, createdAt: NOW, updatedAt: NOW,
    });
    database.state.topUpDuplicateRefundAttempts.set("refund-1", {
      id: "refund-1", topUpAttemptId: "attempt-topup", stripePaymentIntentId: "pi-b", stripeCustomerId: "cus_topup", ownerUserId: "deleted-user", billingOfferId: "offer-topup", amount: 1000, currency: "usd", status: "intervention", notBefore: NOW, leaseToken: null, leaseExpiresAt: null, attempts: 12, refundId: null, refundedAmount: 0, lastError: "identity mismatch", createdAt: NOW, updatedAt: NOW,
    });
    const stripe = stripeFor([], {});

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(database.state.topUpCheckoutAttempts.get("attempt-topup")).toMatchObject({ recoveryInterventionAt: expect.any(Date), recoveryLeaseToken: null });
    expect(database.state.topUpCheckoutResolutions.get("attempt-topup")).toMatchObject({ status: "intervention", lastError: "Top-up duplicate refund requires intervention" });
    const rediscoveryCalls = stripe.checkout.sessions.list.mock.calls.length;

    await reconcileStripeCheckoutCleanups(new Date(NOW.getTime() + 60 * 60_000), "sk_test", stripe);
    expect(stripe.checkout.sessions.list).toHaveBeenCalledTimes(rediscoveryCalls);
    expect(database.state.topUpDuplicateRefundAttempts.get("refund-1")).toMatchObject({ status: "intervention" });
  });

  it("settles a paginated duplicate refund and persists the completed mutation", async () => {
    const database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as any);
    database.state.topUpDuplicateRefundAttempts.set("refund-page", {
      id: "refund-page", topUpAttemptId: "attempt-topup", stripePaymentIntentId: "pi-page", stripeCustomerId: "cus_topup", ownerUserId: "deleted-user", billingOfferId: "offer-topup", amount: 1000, currency: "usd", status: "required", notBefore: NOW, leaseToken: null, leaseExpiresAt: null, attempts: 0, refundId: null, refundedAmount: 0, lastError: null, createdAt: NOW, updatedAt: NOW,
    });
    const stripe = stripeFor([], { "pi-page": 1 });
    stripe.paymentIntents.retrieve = vi.fn(async () => ({ id: "pi-page", status: "succeeded", amount: 1000, amount_received: 1000, currency: "usd", customer: "cus_topup", metadata: { topUpAttemptId: "attempt-topup", beutlUserId: "deleted-user", billingOfferId: "offer-topup", creditAmount: "500" }, latest_charge: { id: "ch-page", created: 1 } }));
    stripe.refunds.list = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "re-failed", amount: 100, status: "failed" }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: "re-succeeded", amount: 1000, status: "succeeded" }], has_more: false });

    await reconcileTopUpDuplicateRefunds(NOW, "sk_test", stripe);
    expect(database.state.topUpDuplicateRefundAttempts.get("refund-page")).toMatchObject({ status: "refunded", refundId: "re-succeeded", refundedAmount: 1000, leaseToken: null });
  });

  it("keeps a newly observed single complete legacy Session in the all-refund outbox", async () => {
    const legacyAttempt: any = {
      id: "legacy-attempt",
      discoveryToken: "legacy-token",
      createdAt: new Date("2026-08-24T23:00:00.000Z"),
      userId: "legacy-user",
      packageId: "package-1",
      customerId: "cus_legacy",
      accountDeletionAt: null,
      paramsJson: JSON.stringify({
        mode: "payment",
        success_url: "https://success",
        cancel_url: "https://cancel",
        line_items: [{ quantity: 1, price_data: { unit_amount: 1000, currency: "usd", product_data: { name: "Credit" } } }],
        metadata: { beutlApplication: "beutl-web", beutlUserId: "legacy-user", beutlPurchaseKind: "package", packageId: "package-1" },
      }),
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    dbMocks.claimPackageInterventions.mockResolvedValue([legacyAttempt]);
    const completeSession: any = {
      id: "cs-raced",
      mode: "payment",
      status: "complete",
      customer: "cus_legacy",
      success_url: "https://success",
      cancel_url: "https://cancel",
      amount_total: 1000,
      currency: "usd",
      payment_intent: "pi-raced",
      metadata: { beutlApplication: "beutl-web", beutlUserId: "legacy-user", beutlPurchaseKind: "package", packageId: "package-1" },
      line_items: { data: [{ quantity: 1, price: { product: { name: "Credit", images: [] } } }] },
    };
    const stripe: any = {
      checkout: { sessions: {
        list: vi.fn(async ({ status }: any) => ({ data: status === "complete" ? [completeSession] : [], has_more: false })),
        retrieve: vi.fn(async () => completeSession),
        expire: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn(async () => ({ id: "pi-raced", status: "succeeded", amount: 1000, amount_received: 1000, currency: "usd", customer: "cus_legacy", metadata: { beutlPurchaseKind: "package", beutlUserId: "legacy-user", packageId: "package-1" }, latest_charge: { id: "ch-raced", created: 10 } })) },
      refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) },
    };

    await reconcileStripeCheckoutCleanups(NOW, "sk_test", stripe);
    expect(dbMocks.schedulePackageResolutionRefunds).toHaveBeenCalledWith(expect.objectContaining({ canonicalSessionId: null, refunds: [expect.objectContaining({ paymentIntentId: "pi-raced", amount: 1000 })] }));
    expect(dbMocks.reschedulePackageIntervention).toHaveBeenCalledWith(expect.objectContaining({ lastError: "Legacy all-refund completion race" }));
    expect(dbMocks.finalizePackageResolution).not.toHaveBeenCalled();
  });
});

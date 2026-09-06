import {
  claimTopUpCheckoutCreation,
  claimTopUpCheckoutResolutionOperatorLease,
  claimUnboundTopUpCheckoutRecoveries,
  claimTopUpDuplicateRefundAttempts,
  clearDetachedTopUpCheckoutRecovery,
  completeTopUpDuplicateRefundAttempt,
  finalizeTopUpCheckoutResolutionAtomically,
  getOrCreateTopUpCheckoutAttempt,
  prepareTopUpsForAccountDeletion,
  recordTopUpRefund,
  recordTopUpCheckoutResolutionAbsenceObservation,
  resumeTopUpCheckoutIntervention,
  terminalizeTopUpCheckoutIntervention,
  markDetachedTopUpCheckoutRecoveryIntervention,
  terminalizeTopUpCheckoutResolutionOnly,
  topUpCheckoutResolutionRefundState,
  listTopUpCheckoutInterventions,
  findTopUpCheckoutIntervention,
  resumeSettledTopUpCheckoutInterventions,
  setDbProvider,
} from "@beutl/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const NOW = new Date("2026-08-26T00:00:00.000Z");

function createArgs(proposedAttemptId: string) {
  return {
    proposedAttemptId,
    ownerUserId: "user-1",
    stripeCustomerId: "cus-1",
    billingOfferId: "offer-1",
    checkoutKey: `ai-top-up-checkout:${proposedAttemptId}`,
    paramsJson: JSON.stringify({
      mode: "payment",
      metadata: { topUpAttemptId: proposedAttemptId },
    }),
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
    now: NOW,
  };
}

describe("durable normal top-up Checkout attempts", () => {
  let database: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as never);
  });

  it("returns one active attempt for concurrent first requests", async () => {
    const [first, second] = await Promise.all([
      getOrCreateTopUpCheckoutAttempt(createArgs("attempt-a")),
      getOrCreateTopUpCheckoutAttempt(createArgs("attempt-b")),
    ]);

    expect(first.id).toBe(second.id);
    expect(database.state.topUpCheckoutAttempts.size).toBe(1);
    expect(first).toMatchObject({
      activeOwnerKey: "user-1",
      checkoutKey: `ai-top-up-checkout:${first.id}`,
      paramsJson: expect.any(String),
    });
  });

  it("grants only one create lease and reclaims it after expiry", async () => {
    const attempt = await getOrCreateTopUpCheckoutAttempt(
      createArgs("attempt-a"),
    );
    const leaseExpiresAt = new Date(NOW.getTime() + 60_000);
    const [first, second] = await Promise.all([
      claimTopUpCheckoutCreation({
        attemptId: attempt.id,
        ownerUserId: "user-1",
        now: NOW,
        leaseToken: "lease-a",
        leaseExpiresAt,
      }),
      claimTopUpCheckoutCreation({
        attemptId: attempt.id,
        ownerUserId: "user-1",
        now: NOW,
        leaseToken: "lease-b",
        leaseExpiresAt,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["busy", "claimed"]);

    const reclaimed = await claimTopUpCheckoutCreation({
      attemptId: attempt.id,
      ownerUserId: "user-1",
      now: new Date(leaseExpiresAt.getTime() + 1),
      leaseToken: "lease-recovered",
      leaseExpiresAt: new Date(leaseExpiresAt.getTime() + 60_000),
    });
    expect(reclaimed).toMatchObject({
      status: "claimed",
      attempt: { createLeaseToken: "lease-recovered" },
    });
  });

  it("refuses to select between multiple unresolved legacy attempts", async () => {
    const first = await getOrCreateTopUpCheckoutAttempt(
      createArgs("attempt-a"),
    );
    database.state.topUpCheckoutAttempts.get(first.id)!.activeOwnerKey = null;
    const duplicate = {
      ...database.state.topUpCheckoutAttempts.get(first.id)!,
      id: "attempt-b",
      checkoutKey: "ai-top-up-checkout:attempt-b",
      createdAt: new Date(NOW.getTime() + 1),
    };
    database.state.topUpCheckoutAttempts.set(duplicate.id, duplicate);

    await expect(
      getOrCreateTopUpCheckoutAttempt(createArgs("attempt-c")),
    ).rejects.toThrow("Multiple unresolved legacy top-up attempts");
    expect(database.state.topUpCheckoutAttempts.size).toBe(2);
  });
});

describe("top-up duplicate refund recovery leases", () => {
  let database: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as never);
  });

  function seedRefund(overrides: Record<string, unknown> = {}) {
    database.state.topUpDuplicateRefundAttempts.set("refund-1", {
      id: "refund-1",
      topUpAttemptId: "attempt-1",
      stripePaymentIntentId: "pi-duplicate",
      stripeCustomerId: "cus-1",
      ownerUserId: "deleted-user",
      billingOfferId: "offer-1",
      amount: 1_000,
      currency: "usd",
      status: "processing",
      notBefore: NOW,
      leaseToken: "crashed-lease",
      leaseExpiresAt: new Date(NOW.getTime() - 1),
      attempts: 5,
      refundId: null,
      refundedAmount: 0,
      lastError: null,
      interventionAt: null,
      lastCanonicalCheckAt: null,
      createdAt: new Date(NOW.getTime() - 60_000),
      updatedAt: new Date(NOW.getTime() - 60_000),
      ...overrides,
    });
  }

  it("reclaims a processing row after its worker lease expires", async () => {
    seedRefund();

    const claimed = await claimTopUpDuplicateRefundAttempts({
      now: NOW,
      leaseToken: "new-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      claimKind: "automatic",
      leaseToken: "new-lease",
      attempts: 6,
    });
  });

  it("preserves canonical-recheck mode after an intervention worker crash", async () => {
    seedRefund({
      attempts: 12,
      interventionAt: new Date(NOW.getTime() - 60 * 60_000),
    });

    const claimed = await claimTopUpDuplicateRefundAttempts({
      now: NOW,
      leaseToken: "new-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });

    expect(claimed[0]).toMatchObject({
      claimKind: "canonical-recheck",
      attempts: 12,
    });
  });

  it("atomically resumes deletion recovery when intervention later settles", async () => {
    seedRefund({
      attempts: 12,
      interventionAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    database.state.topUpCheckoutAttempts.set("attempt-1", {
      id: "attempt-1",
      ownerUserId: "deleted-user",
      activeOwnerKey: "deleted-user",
      checkoutKey: "ai-top-up-checkout:attempt-1",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      status: "refund_required",
      expiresAt: new Date(NOW.getTime() + 60_000),
      accountDeletionAt: new Date(NOW.getTime() - 60_000),
      paramsJson: "{}",
      createLeaseToken: null,
      createLeaseExpiresAt: null,
      recoveryLeaseToken: null,
      recoveryLeaseExpiresAt: null,
      recoveryAttempts: 12,
      recoveryLastError: "Top-up duplicate refund requires intervention",
      recoveryNotBefore: null,
      recoveryInterventionAt: new Date(NOW.getTime() - 60_000),
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
      createdAt: new Date(NOW.getTime() - 60_000),
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    database.state.topUpCheckoutResolutions.set("attempt-1", {
      id: "resolution-1",
      topUpAttemptId: "attempt-1",
      ownerUserId: "deleted-user",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      canonicalSessionId: null,
      expectedPaymentIntentIds: '["pi-duplicate"]',
      status: "intervention",
      revision: 1,
      lastError: "refund intervention",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [claimed] = await claimTopUpDuplicateRefundAttempts({
      now: NOW,
      leaseToken: "new-lease",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });

    const completed = await completeTopUpDuplicateRefundAttempt({
      id: claimed!.id,
      leaseToken: "new-lease",
      refundId: "re-succeeded",
      refundedAmount: 1_000,
      observedAt: NOW,
    });

    expect(completed.count).toBe(1);
    expect(database.state.topUpDuplicateRefundAttempts.get("refund-1")).toMatchObject({
      status: "refunded",
    });
    expect(database.state.topUpCheckoutResolutions.get("attempt-1")).toMatchObject({
      status: "refund_pending",
      lastError: null,
    });
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      recoveryInterventionAt: null,
      recoveryNotBefore: NOW,
      recoveryAttempts: 0,
    });

    const [firstFinalizeClaim] = await claimUnboundTopUpCheckoutRecoveries({
      now: NOW,
      leaseToken: "finalize-lease-1",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect(firstFinalizeClaim).toMatchObject({ recoveryAttempts: 1 });
    await clearDetachedTopUpCheckoutRecovery({
      attemptId: "attempt-1",
      leaseToken: "finalize-lease-1",
      lastError: "temporary Stripe outage",
      notBefore: new Date(NOW.getTime() + 5 * 60_000),
    });
    const retryAt = new Date(NOW.getTime() + 5 * 60_000);
    const [secondFinalizeClaim] = await claimUnboundTopUpCheckoutRecoveries({
      now: retryAt,
      leaseToken: "finalize-lease-2",
      leaseExpiresAt: new Date(retryAt.getTime() + 60_000),
    });
    expect(secondFinalizeClaim).toMatchObject({ recoveryAttempts: 2 });
    await expect(finalizeTopUpCheckoutResolutionAtomically({
      topUpAttemptId: "attempt-1",
      recoveryLeaseToken: "finalize-lease-2",
      finalization: { outcome: "terminal" },
    })).resolves.toBe(true);
    expect(database.state.topUpCheckoutAttempts.get("attempt-1")).toMatchObject({
      status: "refund_not_required",
      activeOwnerKey: null,
    });
    expect(database.state.topUpCheckoutResolutions.get("attempt-1")).toMatchObject({
      status: "terminal",
    });
  });

  it("commits canonical refund success when another worker already resumed the attempt", async () => {
    seedRefund({
      topUpAttemptId: "attempt-healed",
      attempts: 12,
      interventionAt: new Date(NOW.getTime() - 60_000),
    });
    database.state.topUpCheckoutAttempts.set("attempt-healed", {
      id: "attempt-healed",
      ownerUserId: "deleted-user",
      activeOwnerKey: "deleted-user",
      checkoutKey: "ai-top-up-checkout:attempt-healed",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      status: "refund_required",
      expiresAt: NOW,
      accountDeletionAt: new Date(NOW.getTime() - 60_000),
      paramsJson: "{}",
      createLeaseToken: "another-worker",
      createLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
      recoveryLeaseToken: "another-worker",
      recoveryLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
      recoveryAttempts: 1,
      recoveryLastError: null,
      recoveryNotBefore: NOW,
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
      createdAt: new Date(NOW.getTime() - 60_000),
      updatedAt: NOW,
    });
    database.state.topUpCheckoutResolutions.set("attempt-healed", {
      id: "resolution-healed",
      topUpAttemptId: "attempt-healed",
      ownerUserId: "deleted-user",
      stripeCustomerId: "cus-1",
      billingOfferId: "offer-1",
      canonicalSessionId: null,
      canonicalPaymentIntentId: null,
      expectedPaymentIntentIds: '["pi-duplicate"]',
      status: "intervention",
      revision: 2,
      lastError: "manual intervention",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [claimed] = await claimTopUpDuplicateRefundAttempts({
      now: NOW,
      leaseToken: "refund-recheck",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });

    await expect(completeTopUpDuplicateRefundAttempt({
      id: claimed!.id,
      leaseToken: "refund-recheck",
      refundId: "re-late-success",
      refundedAmount: 1_000,
      observedAt: NOW,
    })).resolves.toEqual({ count: 1 });

    expect(database.state.topUpDuplicateRefundAttempts.get("refund-1")).toMatchObject({
      status: "refunded",
      refundId: "re-late-success",
    });
    expect(database.state.topUpCheckoutResolutions.get("attempt-healed")).toMatchObject({
      status: "refund_pending",
      lastError: null,
    });
    expect(database.state.topUpCheckoutAttempts.get("attempt-healed")).toMatchObject({
      recoveryLeaseToken: "another-worker",
      recoveryInterventionAt: null,
    });

    const resolution = database.state.topUpCheckoutResolutions.get("attempt-healed")!;
    resolution.status = "intervention";
    resolution.revision++;
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-healed")!;
    attempt.recoveryLeaseToken = null;
    attempt.recoveryLeaseExpiresAt = null;
    attempt.createLeaseToken = null;
    attempt.createLeaseExpiresAt = null;
    attempt.recoveryInterventionAt = NOW;
    expect(await resumeSettledTopUpCheckoutInterventions({ now: NOW })).toBe(1);
    expect(database.state.topUpCheckoutResolutions.get("attempt-healed")).toMatchObject({
      status: "refund_pending",
    });
    expect(database.state.topUpCheckoutAttempts.get("attempt-healed")).toMatchObject({
      recoveryAttempts: 0,
      recoveryInterventionAt: null,
      recoveryNotBefore: NOW,
    });
  });
});

describe("top-up operator intervention transitions", () => {
  let database: ReturnType<typeof createInMemoryPrisma>;
  const interventionAt = new Date(NOW.getTime() - 60_000);

  beforeEach(() => {
    database = createInMemoryPrisma();
    setDbProvider(async () => database.prisma as never);
  });

  function seedIntervention(accountDeletionAt: Date | null = null) {
    database.state.topUpCheckoutAttempts.set("attempt-intervention", {
      id: "attempt-intervention", ownerUserId: "user-1", activeOwnerKey: "user-1",
      checkoutKey: "ai-top-up-checkout:attempt-intervention", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      stripeCheckoutSessionId: null, stripePaymentIntentId: null, status: accountDeletionAt ? "refund_required" : "open",
      expiresAt: NOW, accountDeletionAt, paramsJson: "{}", createLeaseToken: null, createLeaseExpiresAt: null,
      recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryAttempts: 12, recoveryLastError: "manual",
      recoveryNotBefore: null, recoveryInterventionAt: interventionAt, fulfilledAt: null, refundId: null, refundStatus: null,
      refundStatusObservedAt: null, refundTargetAmount: null, refundSucceededAmount: 0, refundPendingAmount: 0, refundCurrency: null,
      refundNotBefore: NOW, refundLeaseToken: null, refundLeaseExpiresAt: null, refundAttempts: 0, refundLastError: null,
      refundInterventionAt: null, createdAt: NOW, updatedAt: NOW,
    });
    database.state.topUpCheckoutResolutions.set("attempt-intervention", {
      id: "resolution-intervention", topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1",
      billingOfferId: "offer-1", canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: "[]",
      status: "intervention", revision: 4, lastError: "manual", createdAt: NOW, updatedAt: NOW,
    });
  }

  async function claimOperatorLease(
    topUpAttemptId: string,
    expectedRevision: number,
    now: Date = NOW,
  ) {
    const leaseToken = `operator-${topUpAttemptId}-${expectedRevision}`;
    const resolution = await claimTopUpCheckoutResolutionOperatorLease({
      topUpAttemptId,
      expectedRevision,
      leaseToken,
      now,
      leaseExpiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    expect(resolution).not.toBeNull();
    return { leaseToken, resolution: resolution! };
  }

  it("rejects intervention rows from normal purchase and create lease paths", async () => {
    seedIntervention();
    await expect(getOrCreateTopUpCheckoutAttempt(createArgs("new-attempt"))).rejects.toThrow("operator recovery");
    await expect(claimTopUpCheckoutCreation({ attemptId: "attempt-intervention", ownerUserId: "user-1", now: NOW, leaseToken: "lease", leaseExpiresAt: new Date(NOW.getTime() + 60_000) })).resolves.toEqual({ status: "busy" });
  });

  it("retains intervention when account deletion transitions the attempt", async () => {
    seedIntervention();
    await prepareTopUpsForAccountDeletion({ ownerUserId: "user-1", now: NOW, prisma: database.prisma as never });
    expect(database.state.topUpCheckoutAttempts.get("attempt-intervention")).toMatchObject({ accountDeletionAt: NOW, recoveryInterventionAt: interventionAt });
    expect(database.state.topUpCheckoutResolutions.get("attempt-intervention")).toMatchObject({ status: "intervention" });
  });

  it("resumes and terminalizes with identity and revision CAS", async () => {
    seedIntervention();
    await expect(resumeTopUpCheckoutIntervention({ topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW })).resolves.toMatchObject({ status: "resumed", revision: 5 });
    expect(database.state.topUpCheckoutAttempts.get("attempt-intervention")).toMatchObject({ recoveryInterventionAt: null, recoveryNotBefore: NOW });
    expect(database.state.topUpCheckoutResolutions.get("attempt-intervention")).toMatchObject({ status: "refund_pending", revision: 5 });
    await expect(topUpCheckoutResolutionRefundState({ topUpAttemptId: "attempt-intervention" })).resolves.toBe("none");
    seedIntervention(new Date(NOW.getTime() - 1));
    await expect(terminalizeTopUpCheckoutIntervention({ topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW, operatorUserId: "admin-1", operatorReason: "Confirmed no payment was created", operatorEvidence: "Stripe dashboard lookup ticket SEC-123" })).resolves.toMatchObject({ status: "terminalized", revision: 5 });
    expect(database.state.topUpCheckoutAttempts.get("attempt-intervention")).toMatchObject({ status: "refund_not_required", activeOwnerKey: null });
  });

  it("allows only one concurrent operator transition", async () => {
    seedIntervention();
    const args = { topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW };
    const results = await Promise.all([resumeTopUpCheckoutIntervention(args), resumeTopUpCheckoutIntervention(args)]);
    expect(results.filter((item) => item.status === "resumed")).toHaveLength(1);
    expect(results.filter((item) => item.status === "conflict")).toHaveLength(1);
  });

  it("rejects terminalization while a canonical payment intent is known", async () => {
    seedIntervention();
    const resolution = database.state.topUpCheckoutResolutions.get("attempt-intervention")!;
    resolution.canonicalPaymentIntentId = "pi-known";
    await expect(terminalizeTopUpCheckoutIntervention({
      topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW,
      operatorUserId: "admin-1", operatorReason: "Confirmed no payment was created", operatorEvidence: "Stripe ticket SEC-123",
    })).resolves.toMatchObject({ status: "unsafe" });
    expect(database.state.topUpCheckoutResolutions.get("attempt-intervention")?.status).toBe("intervention");
  });

  it("never auto-resumes an intervention with an empty expected PaymentIntent set", async () => {
    seedIntervention();
    expect(await resumeSettledTopUpCheckoutInterventions({ now: NOW })).toBe(0);
    expect(database.state.topUpCheckoutResolutions.get("attempt-intervention")).toMatchObject({ status: "intervention", expectedPaymentIntentIds: "[]" });
    expect(database.state.topUpCheckoutAttempts.get("attempt-intervention")?.recoveryInterventionAt).toEqual(interventionAt);
  });

  it("does not resume a terminal attempt into an unclaimable refund state", async () => {
    seedIntervention();
    database.state.topUpCheckoutAttempts.get("attempt-intervention")!.status = "expired";
    await expect(resumeTopUpCheckoutIntervention({
      topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW,
    })).resolves.toMatchObject({ status: "unsafe" });
    expect(database.state.topUpCheckoutResolutions.get("attempt-intervention")?.status).toBe("intervention");
  });

  it("reopens resolved and terminal resolutions with an exact revision CAS", async () => {
    seedIntervention();
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.recoveryLeaseToken = "lease";
    attempt.createLeaseToken = "lease";
    const resolution = database.state.topUpCheckoutResolutions.get("attempt-intervention")!;
    resolution.status = "resolved";
    resolution.revision = 7;
    await expect(markDetachedTopUpCheckoutRecoveryIntervention({ attemptId: attempt.id, leaseToken: "lease", lastError: "remote state changed" })).resolves.toMatchObject({ count: 1 });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({ status: "intervention", revision: 8, lastError: "remote state changed" });

    const secondAttempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    secondAttempt.recoveryLeaseToken = "lease-2";
    secondAttempt.createLeaseToken = "lease-2";
    const next = database.state.topUpCheckoutResolutions.get(attempt.id)!;
    next.status = "terminal";
    next.revision = 12;
    await expect(markDetachedTopUpCheckoutRecoveryIntervention({ attemptId: attempt.id, leaseToken: "lease-2", lastError: "late Stripe evidence" })).resolves.toMatchObject({ count: 1 });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({ status: "intervention", revision: 13 });
  });

  it("keeps an observed attempt PaymentIntent canonical instead of inventing duplicate refund work", async () => {
    seedIntervention();
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.stripePaymentIntentId = "pi-canonical";
    attempt.recoveryLeaseToken = "lease-canonical";
    attempt.createLeaseToken = "lease-canonical";
    database.state.topUpCheckoutResolutions.delete(attempt.id);
    await expect(markDetachedTopUpCheckoutRecoveryIntervention({
      attemptId: attempt.id,
      leaseToken: "lease-canonical",
      lastError: "lost response",
    })).resolves.toMatchObject({ count: 1 });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({
      canonicalPaymentIntentId: "pi-canonical",
      expectedPaymentIntentIds: "[]",
      status: "intervention",
    });
  });

  it("fails closed when attempt-side refund evidence exists", async () => {
    seedIntervention();
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.refundStatus = "pending";
    await expect(terminalizeTopUpCheckoutIntervention({
      topUpAttemptId: attempt.id, ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW,
      operatorUserId: "admin-1", operatorReason: "no payment", operatorEvidence: "ticket",
    })).resolves.toMatchObject({ status: "unsafe" });
  });

  it("fails closed when a linked credit purchase exists", async () => {
    seedIntervention();
    database.state.creditTransactions.push({
      id: "purchase-1", userId: "user-1", creditAmount: 100, debtAmount: 0, usageAmount: 0,
      usagePeriodStart: null, usagePeriodEnd: null, kind: "purchase", aiJobId: null,
      stripePaymentId: "pi-ledger", stripePaymentAmount: 100, stripeCurrency: "usd", stripeSourcePaymentId: null,
      stripeReversalKind: null, stripeReversalId: null, stripeReversalRevision: null, adminAdjustmentKey: null,
      topUpCheckoutAttemptId: "attempt-intervention", createdAt: NOW,
    });
    await expect(terminalizeTopUpCheckoutIntervention({
      topUpAttemptId: "attempt-intervention", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      expectedRevision: 4, expectedInterventionAt: interventionAt, now: NOW,
      operatorUserId: "admin-1", operatorReason: "no payment", operatorEvidence: "ticket",
    })).resolves.toMatchObject({ status: "unsafe" });
  });

  it("keeps an orphan resolution visible and requires a full refund before terminalization", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-1", {
      id: "resolution-orphan", topUpAttemptId: "orphan-1", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: '["pi-orphan"]', status: "intervention", revision: 2, lastError: "attempt deleted", createdAt: NOW, updatedAt: NOW,
    });
    database.state.topUpDuplicateRefundAttempts.set("orphan-refund", {
      id: "orphan-refund", topUpAttemptId: "orphan-1", stripePaymentIntentId: "pi-orphan", stripeCustomerId: "cus-1", ownerUserId: "user-1", billingOfferId: "offer-1", amount: 1000, currency: "usd", status: "refunded", notBefore: NOW, leaseToken: null, leaseExpiresAt: null, attempts: 1, refundId: "re-orphan", refundedAmount: 999, lastError: null, interventionAt: null, lastCanonicalCheckAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    expect((await listTopUpCheckoutInterventions()).some((row) => row.resolution.topUpAttemptId === "orphan-1" && row.attempt === null)).toBe(true);
    const lease = await claimOperatorLease("orphan-1", 2);
    await expect(terminalizeTopUpCheckoutResolutionOnly({ topUpAttemptId: "orphan-1", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: lease.resolution.revision, operatorUserId: "admin", operatorReason: "Confirmed remote refund remains partial", operatorEvidence: "Stripe ticket ORPHAN-1", proof: { kind: "sessions-settled", checkedAt: NOW.toISOString(), sessions: [{ id: "cs-orphan", status: "expired" }] }, operatorLeaseToken: lease.leaseToken, now: NOW })).resolves.toMatchObject({ status: "unsafe" });
    database.state.topUpDuplicateRefundAttempts.get("orphan-refund")!.refundedAmount = 1000;
    await expect(terminalizeTopUpCheckoutResolutionOnly({ topUpAttemptId: "orphan-1", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: lease.resolution.revision, operatorUserId: "admin", operatorReason: "Confirmed full remote refund settled", operatorEvidence: "Stripe ticket ORPHAN-1", proof: { kind: "sessions-settled", checkedAt: NOW.toISOString(), sessions: [{ id: "cs-orphan", status: "expired" }] }, operatorLeaseToken: lease.leaseToken, now: NOW })).resolves.toMatchObject({ status: "terminalized", revision: lease.resolution.revision + 1 });
  });

  it("keeps an evidence-free orphan in operator intervention during deletion", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-unknown", {
      id: "resolution-orphan-unknown", topUpAttemptId: "orphan-unknown", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: "[]", status: "refund_pending", revision: 0, lastError: null, createdAt: NOW, updatedAt: NOW,
    });
    await prepareTopUpsForAccountDeletion({ ownerUserId: "user-1", now: NOW, prisma: database.prisma as never });
    expect(database.state.topUpCheckoutResolutions.get("orphan-unknown")).toMatchObject({
      status: "intervention",
      lastError: "Orphaned top-up resolution requires operator Stripe evidence",
    });
    expect((await listTopUpCheckoutInterventions()).some((row) =>
      row.resolution.topUpAttemptId === "orphan-unknown" && row.attempt === null)).toBe(true);
  });

  it("terminalizes canonical orphan money only with matching server proof", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-canonical", {
      id: "resolution-orphan-canonical", topUpAttemptId: "orphan-canonical", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: "cs-canonical", canonicalPaymentIntentId: "pi-canonical", expectedPaymentIntentIds: "[]", status: "intervention", revision: 3, lastError: "attempt missing", createdAt: NOW, updatedAt: NOW,
    });
    const lease = await claimOperatorLease("orphan-canonical", 3);
    const input = {
      topUpAttemptId: "orphan-canonical", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: lease.resolution.revision,
      operatorUserId: "admin", operatorReason: "Verified the canonical refund", operatorEvidence: "Stripe incident CANONICAL-1",
      operatorLeaseToken: lease.leaseToken,
      now: NOW,
    };
    await expect(terminalizeTopUpCheckoutResolutionOnly({
      ...input,
      proof: { kind: "payment-intent-refunded", paymentIntentId: "pi-other", status: "succeeded", amountReceived: 1000, refundedAmount: 1000, refundIds: ["re-other"], currency: "usd" },
    })).resolves.toMatchObject({ status: "unsafe" });
    await expect(terminalizeTopUpCheckoutResolutionOnly({
      ...input,
      proof: { kind: "payment-intent-refunded", paymentIntentId: "pi-canonical", status: "succeeded", amountReceived: 1000, refundedAmount: 1000, refundIds: ["re-canonical"], currency: "usd" },
    })).resolves.toMatchObject({ status: "terminalized", revision: lease.resolution.revision + 1 });
    expect(database.state.topUpCheckoutResolutions.get("orphan-canonical")?.operatorEvidence)
      .toContain("pi-canonical");
  });

  it("accepts an unlisted completed Session only with its own full settlement proof", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-discovered", {
      id: "resolution-orphan-discovered", topUpAttemptId: "orphan-discovered", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: "[]", status: "intervention", revision: 1, lastError: "late session", createdAt: NOW, updatedAt: NOW,
    });
    const lease = await claimOperatorLease("orphan-discovered", 1);
    const base = {
      topUpAttemptId: "orphan-discovered", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1", expectedRevision: lease.resolution.revision,
      operatorUserId: "admin", operatorReason: "Verified late completed Session", operatorEvidence: "Stripe ticket LATE-1",
      operatorLeaseToken: lease.leaseToken,
      now: NOW,
    };
    await expect(terminalizeTopUpCheckoutResolutionOnly({
      ...base,
      proof: { kind: "sessions-settled", checkedAt: NOW.toISOString(), sessions: [{ id: "cs-late", status: "complete", paymentProof: { kind: "payment-intent-refunded", paymentIntentId: "pi-late", sessionId: "cs-late", status: "succeeded", amountReceived: 1000, refundedAmount: 999, refundIds: ["re-late"], currency: "usd" } }] },
    })).resolves.toMatchObject({ status: "unsafe" });
    await expect(terminalizeTopUpCheckoutResolutionOnly({
      ...base,
      proof: { kind: "sessions-settled", checkedAt: NOW.toISOString(), sessions: [{ id: "cs-late", status: "complete", paymentProof: { kind: "payment-intent-refunded", paymentIntentId: "pi-late", sessionId: "cs-late", status: "succeeded", amountReceived: 1000, refundedAmount: 1000, refundIds: ["re-late"], currency: "usd" } }] },
    })).resolves.toMatchObject({ status: "terminalized", revision: lease.resolution.revision + 1 });
  });

  it("does not let the resolution-only action bypass an active attempt", async () => {
    seedIntervention();
    await expect(claimTopUpCheckoutResolutionOperatorLease({
      topUpAttemptId: "attempt-intervention",
      expectedRevision: 4,
      leaseToken: "operator-active",
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
    })).resolves.toBeNull();
  });

  it("requires two separated absence observations while the operator lease blocks other claims", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-absence", {
      id: "resolution-orphan-absence", topUpAttemptId: "orphan-absence", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: "[]", status: "intervention", revision: 0, lastError: null, createdAt: NOW, updatedAt: NOW,
    });
    const first = await claimOperatorLease("orphan-absence", 0);
    await expect(recordTopUpCheckoutResolutionAbsenceObservation({
      topUpAttemptId: "orphan-absence",
      leaseToken: first.leaseToken,
      expectedRevision: first.resolution.revision,
      observedAt: NOW,
    })).resolves.toEqual({ count: 1 });
    const recorded = database.state.topUpCheckoutResolutions.get("orphan-absence")!;
    await expect(claimTopUpCheckoutResolutionOperatorLease({
      topUpAttemptId: "orphan-absence",
      expectedRevision: recorded.revision,
      leaseToken: "operator-too-early",
      now: new Date(NOW.getTime() + 60_000),
      leaseExpiresAt: new Date(NOW.getTime() + 11 * 60_000),
    })).resolves.toBeNull();
    const confirmedAt = new Date(NOW.getTime() + 5 * 60_000 + 1);
    const second = await claimOperatorLease(
      "orphan-absence",
      recorded.revision,
      confirmedAt,
    );
    await expect(terminalizeTopUpCheckoutResolutionOnly({
      topUpAttemptId: "orphan-absence", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      expectedRevision: second.resolution.revision, operatorUserId: "admin", operatorReason: "Confirmed two Stripe absence scans", operatorEvidence: "Stripe scans ABSENCE-1",
      proof: { kind: "discovery-absent", firstObservedAt: NOW.toISOString(), checkedAt: confirmedAt.toISOString() },
      operatorLeaseToken: second.leaseToken,
      now: confirmedAt,
    })).resolves.toMatchObject({ status: "terminalized" });
  });

  it("does not revive an expired operator lease as an absence observation", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-expired-lease", {
      id: "resolution-orphan-expired-lease", topUpAttemptId: "orphan-expired-lease", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: "[]", status: "intervention", revision: 0, lastError: null, createdAt: NOW, updatedAt: NOW,
    });
    const lease = await claimOperatorLease("orphan-expired-lease", 0);
    await expect(recordTopUpCheckoutResolutionAbsenceObservation({
      topUpAttemptId: "orphan-expired-lease",
      leaseToken: lease.leaseToken,
      expectedRevision: lease.resolution.revision,
      observedAt: new Date(NOW.getTime() + 11 * 60_000),
    })).resolves.toEqual({ count: 0 });
  });

  it("records a duplicate refund without changing a resolution held by an operator lease", async () => {
    database.state.topUpCheckoutResolutions.set("orphan-leased-refund", {
      id: "resolution-orphan-leased-refund", topUpAttemptId: "orphan-leased-refund", ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedPaymentIntentIds: '["pi-leased"]', status: "intervention", revision: 0, lastError: "operator reviewing", createdAt: NOW, updatedAt: NOW,
    });
    database.state.topUpDuplicateRefundAttempts.set("leased-refund", {
      id: "leased-refund", topUpAttemptId: "orphan-leased-refund", stripePaymentIntentId: "pi-leased", stripeCustomerId: "cus-1", ownerUserId: "user-1", billingOfferId: "offer-1",
      amount: 1000, currency: "usd", status: "processing", notBefore: NOW, leaseToken: "refund-worker", leaseExpiresAt: new Date(NOW.getTime() + 60_000), attempts: 1,
      refundId: null, refundedAmount: 0, lastError: null, interventionAt: null, lastCanonicalCheckAt: null, createdAt: NOW, updatedAt: NOW,
    });
    const lease = await claimOperatorLease("orphan-leased-refund", 0);
    await expect(completeTopUpDuplicateRefundAttempt({
      id: "leased-refund",
      leaseToken: "refund-worker",
      refundId: "re-leased",
      refundedAmount: 1000,
      observedAt: NOW,
    })).resolves.toEqual({ count: 1 });
    expect(database.state.topUpDuplicateRefundAttempts.get("leased-refund")).toMatchObject({ status: "refunded", refundedAmount: 1000 });
    expect(database.state.topUpCheckoutResolutions.get("orphan-leased-refund")).toMatchObject({
      status: "intervention",
      revision: lease.resolution.revision,
      operatorLeaseToken: lease.leaseToken,
    });
  });

  it("terminalizes a refund-not-required attempt after server-verified no-money proof", async () => {
    seedIntervention(new Date(NOW.getTime() - 1));
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.status = "refund_not_required";
    attempt.refundStatus = "not_required";
    attempt.recoveryInterventionAt = interventionAt;
    const lease = await claimOperatorLease(attempt.id, 4);
    await expect(terminalizeTopUpCheckoutResolutionOnly({
      topUpAttemptId: attempt.id, ownerUserId: "user-1", stripeCustomerId: "cus-1", billingOfferId: "offer-1",
      expectedRevision: lease.resolution.revision, operatorUserId: "admin", operatorReason: "Verified no refundable payment", operatorEvidence: "Stripe scan NOT-REQUIRED-1",
      proof: { kind: "sessions-settled", checkedAt: NOW.toISOString(), sessions: [{ id: "cs-expired", status: "expired" }] },
      operatorLeaseToken: lease.leaseToken,
      now: NOW,
    })).resolves.toMatchObject({ status: "terminalized" });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)?.status).toBe("terminal");
  });

  it("does not record a partial duplicate refund as terminally refunded", async () => {
    database.state.topUpDuplicateRefundAttempts.set("partial-write", {
      id: "partial-write", topUpAttemptId: "orphan-partial", stripePaymentIntentId: "pi-partial", stripeCustomerId: "cus-1", ownerUserId: "user-1", billingOfferId: "offer-1",
      amount: 1000, currency: "usd", status: "processing", notBefore: NOW, leaseToken: "refund-lease", leaseExpiresAt: new Date(NOW.getTime() + 60_000), attempts: 1,
      refundId: null, refundedAmount: 0, lastError: null, interventionAt: null, lastCanonicalCheckAt: null, createdAt: NOW, updatedAt: NOW,
    });
    await expect(completeTopUpDuplicateRefundAttempt({ id: "partial-write", leaseToken: "refund-lease", refundId: "re-partial", refundedAmount: 999, observedAt: NOW })).resolves.toEqual({ count: 0 });
    expect(database.state.topUpDuplicateRefundAttempts.get("partial-write")).toMatchObject({ status: "processing", refundedAmount: 0 });
  });

  it("settles the resolution when the canonical refund completes in full", async () => {
    seedIntervention(new Date(NOW.getTime() - 1));
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.status = "refund_required";
    await expect(recordTopUpRefund({
      attemptId: attempt.id,
      stripePaymentIntentId: "pi-main",
      refundId: "re-main",
      refundStatus: "succeeded",
      refundTargetAmount: 1000,
      refundSucceededAmount: 1000,
      refundPendingAmount: 0,
      refundCurrency: "usd",
      now: NOW,
    })).resolves.toEqual({ count: 1 });
    expect(database.state.topUpCheckoutAttempts.get(attempt.id)).toMatchObject({
      status: "refunded",
      recoveryInterventionAt: null,
    });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({
      status: "terminal",
      revision: 5,
    });
  });

  it("keeps a full main refund in intervention when it does not match the canonical identity", async () => {
    seedIntervention(new Date(NOW.getTime() - 1));
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.status = "refund_required";
    database.state.topUpCheckoutResolutions.get(attempt.id)!.canonicalPaymentIntentId = "pi-canonical-a";
    await recordTopUpRefund({
      attemptId: attempt.id,
      stripePaymentIntentId: "pi-refunded-b",
      refundId: "re-b",
      refundStatus: "succeeded",
      refundTargetAmount: 1000,
      refundSucceededAmount: 1000,
      refundPendingAmount: 0,
      refundCurrency: "usd",
      now: NOW,
    });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({
      status: "intervention",
      lastError: "Main refund settled a different canonical Stripe identity",
    });
  });

  it("does not let a legacy partial main-refund status clear the deletion blocker", async () => {
    seedIntervention(new Date(NOW.getTime() - 1));
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.status = "refunded";
    attempt.stripePaymentIntentId = "pi-partial-main";
    attempt.refundTargetAmount = 1000;
    attempt.refundSucceededAmount = 999;
    attempt.refundPendingAmount = 0;
    const resolution = database.state.topUpCheckoutResolutions.get(attempt.id)!;
    resolution.status = "refund_pending";
    resolution.canonicalPaymentIntentId = "pi-partial-main";
    await prepareTopUpsForAccountDeletion({ ownerUserId: "user-1", now: NOW, prisma: database.prisma as never });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({
      status: "intervention",
      lastError: "Refunded attempt does not prove the resolution's canonical Stripe identity",
    });
  });

  it("resolves a fulfilled intervention during deletion only with matching ledger proof", async () => {
    seedIntervention();
    const attempt = database.state.topUpCheckoutAttempts.get("attempt-intervention")!;
    attempt.status = "fulfilled";
    attempt.stripeCheckoutSessionId = "cs-fulfilled";
    attempt.stripePaymentIntentId = "pi-fulfilled";
    attempt.fulfilledAt = NOW;
    const resolution = database.state.topUpCheckoutResolutions.get(attempt.id)!;
    resolution.canonicalSessionId = "cs-fulfilled";
    resolution.canonicalPaymentIntentId = "pi-fulfilled";
    database.state.creditTransactions.push({
      id: "purchase-fulfilled", userId: "user-1", creditAmount: 100, debtAmount: 0, usageAmount: 0,
      usagePeriodStart: null, usagePeriodEnd: null, kind: "purchase", aiJobId: null,
      stripePaymentId: "pi-fulfilled", stripePaymentAmount: 100, stripeCurrency: "usd", stripeSourcePaymentId: null,
      stripeReversalKind: null, stripeReversalId: null, stripeReversalRevision: null, adminAdjustmentKey: null,
      topUpCheckoutAttemptId: attempt.id, createdAt: NOW,
    });
    await prepareTopUpsForAccountDeletion({ ownerUserId: "user-1", now: NOW, prisma: database.prisma as never });
    expect(database.state.topUpCheckoutResolutions.get(attempt.id)).toMatchObject({
      status: "resolved",
      revision: 5,
    });
    expect(database.state.topUpCheckoutAttempts.get(attempt.id)?.recoveryInterventionAt).toBeNull();
  });

  it("does not lazily create a resolution when a detached marker has no resolution row", async () => {
    seedIntervention();
    database.state.topUpCheckoutResolutions.delete("attempt-intervention");
    const intervention = await findTopUpCheckoutIntervention({ ownerUserId: "user-1" });
    expect(intervention).toBeNull();
    expect(database.state.topUpCheckoutResolutions.get("attempt-intervention")).toBeUndefined();
  });
});

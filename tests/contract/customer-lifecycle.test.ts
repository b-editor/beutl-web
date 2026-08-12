import { beforeEach, describe, expect, it, vi } from "vitest";

const LEGACY_COHORT = "pre-owner-metadata-2026-08-09";
const mocks = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  checkoutRetrieve: vi.fn(),
  expireCheckoutSession: vi.fn(),
  createCustomer: vi.fn(),
  createVerifiedCustomerMappingIfAbsent: vi.fn(),
  deleteCustomer: vi.fn(),
  findAccountDeletionIntentByUserId: vi.fn(),
  findBillingOfferById: vi.fn(),
  findBoundProCheckoutAttemptForAccountDeletion: vi.fn(),
  findCustomerByUserId: vi.fn(),
  findStripeCustomerOwnershipByStripeId: vi.fn(),
  invoicePaymentList: vi.fn(),
  listSubscriptions: vi.fn(),
  listCheckoutSessions: vi.fn(),
  markStripeCustomerOwnershipVerified: vi.fn(),
  recordBillingRefundCancellation: vi.fn(),
  replaceCustomerMappingWithVerifiedOwnership: vi.fn(),
  retrieveCustomer: vi.fn(),
  retrieveSubscription: vi.fn(),
  scheduleBillingRefundAttempt: vi.fn(),
  startRetryableTransaction: vi.fn(),
  updateCustomer: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  LEGACY_STRIPE_CUSTOMER_MIGRATION_COHORT:
    "pre-owner-metadata-2026-08-09",
  createVerifiedCustomerMappingIfAbsent:
    mocks.createVerifiedCustomerMappingIfAbsent,
  findAccountDeletionIntentByUserId: mocks.findAccountDeletionIntentByUserId,
  findBillingOfferById: mocks.findBillingOfferById,
  findBoundProCheckoutAttemptForAccountDeletion:
    mocks.findBoundProCheckoutAttemptForAccountDeletion,
  findCustomerByUserId: mocks.findCustomerByUserId,
  findStripeCustomerOwnershipByStripeId:
    mocks.findStripeCustomerOwnershipByStripeId,
  markStripeCustomerOwnershipVerified:
    mocks.markStripeCustomerOwnershipVerified,
  recordBillingRefundCancellation: mocks.recordBillingRefundCancellation,
  replaceCustomerMappingWithVerifiedOwnership:
    mocks.replaceCustomerMappingWithVerifiedOwnership,
  scheduleBillingRefundAttempt: mocks.scheduleBillingRefundAttempt,
  startRetryableTransaction: mocks.startRetryableTransaction,
}));

vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    checkout: {
      sessions: {
        expire: mocks.expireCheckoutSession,
        list: mocks.listCheckoutSessions,
        retrieve: mocks.checkoutRetrieve,
      },
    },
    invoicePayments: { list: mocks.invoicePaymentList },
    customers: {
      create: mocks.createCustomer,
      del: mocks.deleteCustomer,
      retrieve: mocks.retrieveCustomer,
      update: mocks.updateCustomer,
    },
    subscriptions: {
      cancel: mocks.cancelSubscription,
      list: mocks.listSubscriptions,
      retrieve: mocks.retrieveSubscription,
    },
  }),
}));

import {
  closeStripeCustomerForAccountDeletion,
  createOrRetrieveOwnedCustomerId,
  updateCustomerEmailIfExist,
} from "../../apps/web/src/lib/customer";

const resourceMissing = {
  code: "resource_missing",
  statusCode: 404,
  type: "StripeInvalidRequestError",
};

function ownerMetadata(userId = "user-1") {
  return {
    beutlApplication: "beutl-web",
    beutlUserId: userId,
  };
}

function verifiedOwnership(stripeId: string, userId = "user-1") {
  return {
    stripeId,
    userId,
    migrationCohort: null,
    verifiedAt: new Date("2026-08-09T00:00:00.000Z"),
  };
}

function legacyOwnership(stripeId: string, userId = "user-1") {
  return {
    stripeId,
    userId,
    migrationCohort: LEGACY_COHORT,
    verifiedAt: null,
  };
}

function mapping(
  stripeId: string,
  ownership = verifiedOwnership(stripeId),
  userId = ownership.userId,
) {
  return { userId, stripeId, ownership };
}

const proOffer = {
  id: "offer_pro_v1",
  kind: "pro",
  stripePriceId: "price_pro",
  stripeProductId: "prod_pro",
  unitAmount: 2_000,
  currency: "usd",
  creditAmount: null,
  recurringInterval: "month",
  recurringIntervalCount: 1,
  checkoutEnabled: true,
};

function proCheckoutSession(status: "open" | "complete" | "expired") {
  return {
    id: "cs_bound",
    status,
    mode: "subscription",
    customer: "cus_existing",
    subscription: status === "complete" ? "sub_bound" : null,
    invoice: status === "complete" ? "in_bound" : null,
    metadata: {
      ...ownerMetadata(),
      planId: "pro",
      billingOfferId: "offer_pro_v1",
    },
    line_items: {
      data: [{ quantity: 1, price: "price_pro" }],
    },
  };
}

function proSubscription() {
  return {
    id: "sub_bound",
    customer: "cus_existing",
    status: "active",
    metadata: {
      ...ownerMetadata(),
      planId: "pro",
      billingOfferId: "offer_pro_v1",
    },
    latest_invoice: "in_bound",
    items: {
      data: [{
        quantity: 1,
        price: {
          id: "price_pro",
          product: "prod_pro",
          unit_amount: 2_000,
          currency: "usd",
          recurring: { interval: "month", interval_count: 1 },
        },
      }],
    },
  };
}

describe("application-owned Stripe customer lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAccountDeletionIntentByUserId.mockResolvedValue(null);
    mocks.findBoundProCheckoutAttemptForAccountDeletion.mockResolvedValue(null);
    mocks.findBillingOfferById.mockResolvedValue(proOffer);
    mocks.cancelSubscription.mockResolvedValue({
      id: "sub_canceled",
      status: "canceled",
    });
    mocks.createCustomer.mockResolvedValue({
      id: "cus_new",
      metadata: ownerMetadata(),
    });
    mocks.createVerifiedCustomerMappingIfAbsent.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_new",
    });
    mocks.replaceCustomerMappingWithVerifiedOwnership.mockResolvedValue({
      count: 1,
    });
    mocks.retrieveCustomer.mockImplementation(async (customerId: string) => ({
      id: customerId,
      deleted: false,
      metadata: ownerMetadata(),
    }));
    mocks.updateCustomer.mockResolvedValue({ id: "cus_existing" });
    mocks.listSubscriptions.mockResolvedValue({
      data: [],
      has_more: false,
      object: "list",
      url: "/v1/subscriptions",
    });
    mocks.listCheckoutSessions.mockResolvedValue({
      data: [],
      has_more: false,
      object: "list",
      url: "/v1/checkout/sessions",
    });
    mocks.expireCheckoutSession.mockResolvedValue({ status: "expired" });
    mocks.invoicePaymentList.mockResolvedValue({ data: [], has_more: false });
    mocks.deleteCustomer.mockResolvedValue({
      id: "cus_existing",
      deleted: true,
    });
    mocks.markStripeCustomerOwnershipVerified.mockResolvedValue({ count: 1 });
    mocks.recordBillingRefundCancellation.mockResolvedValue(true);
    mocks.retrieveSubscription.mockResolvedValue(proSubscription());
    mocks.scheduleBillingRefundAttempt.mockResolvedValue({ id: "refund-1" });
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (prisma: object) => Promise<unknown>) =>
        await callback({ transaction: true }),
    );
  });

  it("creates a verified mapping before syncing secondary customer data", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mapping("cus_new"));

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toBe("cus_new");

    expect(mocks.createCustomer).toHaveBeenCalledWith(
      { metadata: ownerMetadata() },
      { idempotencyKey: "beutl:customer:user-1" },
    );
    expect(mocks.createVerifiedCustomerMappingIfAbsent).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
    });
    expect(
      mocks.createVerifiedCustomerMappingIfAbsent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.updateCustomer.mock.invocationCallOrder[0]);
  });

  it("keeps a verified mapped customer and its active subscriptions", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "new@example.com",
      }),
    ).resolves.toBe("cus_existing");

    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.updateCustomer).toHaveBeenCalledWith("cus_existing", {
      email: "new@example.com",
    });
  });

  it("replaces a metadata-free migration-cohort customer", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(
        mapping("cus_legacy", legacyOwnership("cus_legacy")),
      )
      .mockResolvedValueOnce(mapping("cus_new"));
    mocks.retrieveCustomer.mockResolvedValueOnce({
      id: "cus_legacy",
      deleted: false,
      metadata: {},
    });

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toBe("cus_new");

    expect(mocks.createCustomer).toHaveBeenCalledWith(
      { metadata: ownerMetadata() },
      { idempotencyKey: "beutl:customer:user-1:replace:cus_legacy" },
    );
    expect(mocks.replaceCustomerMappingWithVerifiedOwnership).toHaveBeenCalledWith({
      userId: "user-1",
      expectedStripeId: "cus_legacy",
      stripeId: "cus_new",
    });
    expect(mocks.updateCustomer).not.toHaveBeenCalledWith(
      "cus_legacy",
      expect.anything(),
    );
  });

  it("expires every owned open Checkout session before replacing a customer", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(
        mapping("cus_legacy", legacyOwnership("cus_legacy")),
      )
      .mockResolvedValueOnce(mapping("cus_new"));
    mocks.retrieveCustomer.mockResolvedValueOnce({
      id: "cus_legacy",
      deleted: false,
      metadata: {},
    });
    mocks.listCheckoutSessions
      .mockResolvedValueOnce({
        data: [
          { id: "cs_owned", metadata: ownerMetadata() },
          { id: "cs_unowned", metadata: ownerMetadata("another-user") },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "cs_owned_2", metadata: ownerMetadata() }],
        has_more: false,
      });

    await createOrRetrieveOwnedCustomerId({
      userId: "user-1",
      email: "owner@example.com",
    });

    expect(mocks.listCheckoutSessions).toHaveBeenNthCalledWith(2, {
      customer: "cus_legacy",
      status: "open",
      limit: 100,
      starting_after: "cs_unowned",
    });
    expect(mocks.expireCheckoutSession).toHaveBeenCalledTimes(2);
    expect(mocks.expireCheckoutSession).toHaveBeenCalledWith("cs_owned");
    expect(mocks.expireCheckoutSession).toHaveBeenCalledWith("cs_owned_2");
  });

  it("uses a metadata-owned customer and verifies its legacy ownership record", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(
      mapping("cus_legacy", legacyOwnership("cus_legacy")),
    );
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_legacy",
      deleted: false,
      metadata: ownerMetadata(),
    });

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toBe("cus_legacy");

    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.markStripeCustomerOwnershipVerified).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_legacy",
    });
    expect(mocks.updateCustomer).toHaveBeenCalledWith("cus_legacy", {
      email: "owner@example.com",
    });
  });

  it("never claims conflicting metadata and replaces only the current mapping", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(
        mapping("cus_legacy", legacyOwnership("cus_legacy")),
      )
      .mockResolvedValueOnce(mapping("cus_new"));
    mocks.retrieveCustomer.mockResolvedValueOnce({
      id: "cus_legacy",
      deleted: false,
      metadata: ownerMetadata("another-user"),
    });

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toBe("cus_new");

    expect(
      mocks.replaceCustomerMappingWithVerifiedOwnership,
    ).toHaveBeenCalledWith({
      userId: "user-1",
      expectedStripeId: "cus_legacy",
      stripeId: "cus_new",
    });
    expect(mocks.updateCustomer).not.toHaveBeenCalledWith(
      "cus_legacy",
      expect.anything(),
    );
  });

  it("does not create a duplicate customer on retryable retrieval failure", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.retrieveCustomer.mockRejectedValue(
      new Error("Stripe temporarily unavailable"),
    );

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).rejects.toThrow("Stripe temporarily unavailable");
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it("replaces a deleted mapping without searching by reused email", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(mapping("cus_deleted"))
      .mockResolvedValueOnce(mapping("cus_new"));
    mocks.retrieveCustomer.mockResolvedValueOnce({
      id: "cus_deleted",
      deleted: true,
      metadata: {},
    });

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "reused@example.com",
      }),
    ).resolves.toBe("cus_new");
    expect(mocks.createCustomer).toHaveBeenCalledWith(
      { metadata: ownerMetadata() },
      { idempotencyKey: "beutl:customer:user-1:replace:cus_deleted" },
    );
  });

  it("recovers when Stripe replays a deleted compensated customer", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mapping("cus_recovered"));
    mocks.createCustomer
      .mockResolvedValueOnce({
        id: "cus_deleted_cached",
        metadata: ownerMetadata(),
      })
      .mockResolvedValueOnce({
        id: "cus_recovered",
        metadata: ownerMetadata(),
      });
    mocks.retrieveCustomer
      .mockResolvedValueOnce({ id: "cus_deleted_cached", deleted: true })
      .mockResolvedValueOnce({
        id: "cus_recovered",
        deleted: false,
        metadata: ownerMetadata(),
      });
    mocks.createVerifiedCustomerMappingIfAbsent.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_recovered",
    });

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toBe("cus_recovered");

    expect(mocks.createCustomer).toHaveBeenNthCalledWith(
      2,
      { metadata: ownerMetadata() },
      { idempotencyKey: "beutl:customer-recovery:cus_deleted_cached" },
    );
    expect(mocks.createVerifiedCustomerMappingIfAbsent).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_recovered",
    });
  });

  it("does not return a new customer when verified mapping persistence fails", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(null);
    mocks.createVerifiedCustomerMappingIfAbsent.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).rejects.toThrow("database unavailable");
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).toHaveBeenCalledWith(
      "cus_new",
      {},
      { idempotencyKey: "beutl:unmapped-customer-cleanup:cus_new" },
    );
  });

  it("does not compensate a customer whose mapping committed before email sync failed", async () => {
    mocks.findCustomerByUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValue(mapping("cus_new"));
    mocks.updateCustomer.mockRejectedValue(new Error("Stripe email sync failed"));

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).rejects.toThrow("Stripe email sync failed");

    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("blocks new billing work after deletion authorization", async () => {
    mocks.findAccountDeletionIntentByUserId.mockResolvedValue({
      userId: "user-1",
    });

    await expect(
      createOrRetrieveOwnedCustomerId({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).rejects.toThrow("Account deletion is already authorized");
    expect(mocks.findCustomerByUserId).not.toHaveBeenCalled();
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it("does not sync email for a metadata-free legacy cohort mapping", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(
      mapping("cus_legacy", legacyOwnership("cus_legacy")),
    );
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_legacy",
      deleted: false,
      metadata: {},
    });

    await expect(
      updateCustomerEmailIfExist({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toEqual({
      status: "owner-mismatch",
      customerId: "cus_legacy",
    });
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });

  it("does not mutate a customer with conflicting owner metadata", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(
      mapping("cus_other_owner", legacyOwnership("cus_other_owner")),
    );
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_other_owner",
      deleted: false,
      metadata: ownerMetadata("another-user"),
    });

    await expect(
      updateCustomerEmailIfExist({
        userId: "user-1",
        email: "owner@example.com",
      }),
    ).resolves.toEqual({
      status: "owner-mismatch",
      customerId: "cus_other_owner",
    });
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });

  it("does not close a metadata-free legacy customer", async () => {
    mocks.findStripeCustomerOwnershipByStripeId.mockResolvedValue(
      legacyOwnership("cus_legacy"),
    );
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_legacy",
      deleted: false,
      metadata: {},
    });
    mocks.listSubscriptions.mockResolvedValue({
      data: [
        { id: "sub_active", status: "active" },
        { id: "sub_canceled", status: "canceled" },
      ],
      has_more: false,
      object: "list",
      url: "/v1/subscriptions",
    });

    await expect(
      closeStripeCustomerForAccountDeletion({
        userId: "user-1",
        stripeCustomerId: "cus_legacy",
      }),
    ).resolves.toEqual({
      status: "owner-mismatch",
      customerId: "cus_legacy",
    });

    expect(mocks.cancelSubscription).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("queues compensation before deleting a customer when a bound Checkout completes during expiry", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.findBoundProCheckoutAttemptForAccountDeletion.mockResolvedValue({
      billingOfferId: "offer_pro_v1",
      stripeCheckoutSessionId: "cs_bound",
    });
    mocks.checkoutRetrieve
      .mockResolvedValueOnce(proCheckoutSession("open"))
      .mockResolvedValueOnce(proCheckoutSession("complete"));
    mocks.expireCheckoutSession.mockRejectedValue(
      new Error("Checkout Session is no longer open"),
    );
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_bound",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_bound" },
      }],
      has_more: false,
    });
    mocks.listSubscriptions.mockResolvedValue({
      data: [{ id: "sub_bound", status: "canceled" }],
      has_more: false,
      object: "list",
      url: "/v1/subscriptions",
    });
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (prisma: object) => Promise<unknown>) => {
        await callback({ transaction: true });
        return await callback({ transaction: true });
      },
    );

    await closeStripeCustomerForAccountDeletion({ userId: "user-1" });

    expect(
      mocks.findBoundProCheckoutAttemptForAccountDeletion,
    ).toHaveBeenCalledWith({ userId: "user-1" });
    expect(mocks.checkoutRetrieve).toHaveBeenNthCalledWith(1, "cs_bound", {
      expand: ["line_items.data.price"],
    });
    expect(mocks.expireCheckoutSession).toHaveBeenCalledWith("cs_bound");
    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledWith({
      disposition: "superseded-pro-checkout",
      sourceKey: "cs_bound:pi_bound",
      stripeCustomerId: "cus_existing",
      stripeCheckoutSessionId: "cs_bound",
      stripeSubscriptionId: "sub_bound",
      stripeInvoiceId: "in_bound",
      stripePaymentIntentId: "pi_bound",
      prisma: { transaction: true },
    });
    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.cancelSubscription).toHaveBeenCalledWith(
      "sub_bound",
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: "beutl:account-delete:subscription:sub_bound",
      },
    );
    expect(mocks.recordBillingRefundCancellation).toHaveBeenCalledWith({
      attemptId: "refund-1",
      now: expect.any(Date),
      prisma: { transaction: true },
    });
    expect(mocks.recordBillingRefundCancellation).toHaveBeenCalledTimes(2);
    expect(
      mocks.scheduleBillingRefundAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.cancelSubscription.mock.invocationCallOrder[0]);
    expect(
      mocks.cancelSubscription.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.recordBillingRefundCancellation.mock.invocationCallOrder[0],
    );
    expect(
      mocks.recordBillingRefundCancellation.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.deleteCustomer.mock.invocationCallOrder[0]);
  });

  it("keeps the customer and bound Checkout handle when compensation cannot persist", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.findBoundProCheckoutAttemptForAccountDeletion.mockResolvedValue({
      billingOfferId: "offer_pro_v1",
      stripeCheckoutSessionId: "cs_bound",
    });
    mocks.checkoutRetrieve.mockResolvedValue(proCheckoutSession("complete"));
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_bound",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_bound" },
      }],
      has_more: false,
    });
    mocks.scheduleBillingRefundAttempt.mockRejectedValue(
      new Error("refund persistence unavailable"),
    );

    await expect(
      closeStripeCustomerForAccountDeletion({ userId: "user-1" }),
    ).rejects.toThrow("refund persistence unavailable");

    expect(mocks.cancelSubscription).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("does not delete a customer until bound Checkout cancellation is durably recorded", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.findBoundProCheckoutAttemptForAccountDeletion.mockResolvedValue({
      billingOfferId: "offer_pro_v1",
      stripeCheckoutSessionId: "cs_bound",
    });
    mocks.checkoutRetrieve.mockResolvedValue(proCheckoutSession("complete"));
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_bound",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_bound" },
      }],
      has_more: false,
    });
    mocks.recordBillingRefundCancellation.mockResolvedValue(false);

    await expect(
      closeStripeCustomerForAccountDeletion({ userId: "user-1" }),
    ).rejects.toThrow("Failed to persist account-deletion cancellation");

    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalled();
    expect(mocks.cancelSubscription).toHaveBeenCalledWith(
      "sub_bound",
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: "beutl:account-delete:subscription:sub_bound",
      },
    );
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("does not delete a customer when bound Checkout cancellation remains non-terminal", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.findBoundProCheckoutAttemptForAccountDeletion.mockResolvedValue({
      billingOfferId: "offer_pro_v1",
      stripeCheckoutSessionId: "cs_bound",
    });
    mocks.checkoutRetrieve.mockResolvedValue(proCheckoutSession("complete"));
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_bound",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_bound" },
      }],
      has_more: false,
    });
    mocks.cancelSubscription.mockResolvedValue({
      id: "sub_bound",
      status: "active",
    });

    await expect(
      closeStripeCustomerForAccountDeletion({ userId: "user-1" }),
    ).rejects.toThrow("Subscription sub_bound remains active after cancellation");

    expect(mocks.recordBillingRefundCancellation).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("does not delete a customer when the bound Checkout fails ownership validation", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.findBoundProCheckoutAttemptForAccountDeletion.mockResolvedValue({
      billingOfferId: "offer_pro_v1",
      stripeCheckoutSessionId: "cs_bound",
    });
    mocks.checkoutRetrieve.mockResolvedValue({
      ...proCheckoutSession("complete"),
      metadata: {
        ...ownerMetadata("another-user"),
        planId: "pro",
        billingOfferId: "offer_pro_v1",
      },
    });

    await expect(
      closeStripeCustomerForAccountDeletion({ userId: "user-1" }),
    ).rejects.toThrow("failed ownership validation");

    expect(mocks.scheduleBillingRefundAttempt).not.toHaveBeenCalled();
    expect(mocks.cancelSubscription).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("propagates retryable cancellation failures and leaves the customer open", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.listSubscriptions.mockResolvedValue({
      data: [{ id: "sub_active", status: "active" }],
      has_more: false,
      object: "list",
      url: "/v1/subscriptions",
    });
    mocks.cancelSubscription.mockRejectedValue(
      new Error("Stripe temporarily unavailable"),
    );

    await expect(
      closeStripeCustomerForAccountDeletion({ userId: "user-1" }),
    ).rejects.toThrow("Stripe temporarily unavailable");
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("does not delete a customer when Stripe reports a non-terminal cancellation", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.listSubscriptions.mockResolvedValue({
      data: [{ id: "sub_active", status: "active" }],
      has_more: false,
      object: "list",
      url: "/v1/subscriptions",
    });
    mocks.cancelSubscription.mockResolvedValue({
      id: "sub_active",
      status: "active",
    });

    await expect(
      closeStripeCustomerForAccountDeletion({ userId: "user-1" }),
    ).rejects.toThrow("Subscription sub_active remains active after cancellation");

    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });

  it("paginates through every subscription before closing the customer", async () => {
    mocks.findCustomerByUserId.mockResolvedValue(mapping("cus_existing"));
    mocks.listSubscriptions
      .mockResolvedValueOnce({
        data: [{ id: "sub_page_1", status: "active" }],
        has_more: true,
        object: "list",
        url: "/v1/subscriptions",
      })
      .mockResolvedValueOnce({
        data: [{ id: "sub_page_2", status: "past_due" }],
        has_more: false,
        object: "list",
        url: "/v1/subscriptions",
      });

    await closeStripeCustomerForAccountDeletion({ userId: "user-1" });

    expect(mocks.listSubscriptions).toHaveBeenNthCalledWith(2, {
      customer: "cus_existing",
      status: "all",
      limit: 100,
      starting_after: "sub_page_1",
    });
    expect(mocks.cancelSubscription).toHaveBeenCalledTimes(2);
  });

  it("treats a definitively missing snapshotted customer as already closed", async () => {
    mocks.findStripeCustomerOwnershipByStripeId.mockResolvedValue(
      verifiedOwnership("cus_missing"),
    );
    mocks.retrieveCustomer.mockRejectedValue(resourceMissing);

    await expect(
      closeStripeCustomerForAccountDeletion({
        userId: "user-1",
        stripeCustomerId: "cus_missing",
      }),
    ).resolves.toEqual({
      status: "already-closed",
      customerId: "cus_missing",
    });
    expect(mocks.listSubscriptions).not.toHaveBeenCalled();
  });

  it("does not cancel or delete a customer owned by another user", async () => {
    mocks.findStripeCustomerOwnershipByStripeId.mockResolvedValue(
      legacyOwnership("cus_other_owner"),
    );
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_other_owner",
      deleted: false,
      metadata: ownerMetadata("another-user"),
    });

    await expect(
      closeStripeCustomerForAccountDeletion({
        userId: "user-1",
        stripeCustomerId: "cus_other_owner",
      }),
    ).resolves.toEqual({
      status: "owner-mismatch",
      customerId: "cus_other_owner",
    });
    expect(mocks.cancelSubscription).not.toHaveBeenCalled();
    expect(mocks.deleteCustomer).not.toHaveBeenCalled();
  });
});

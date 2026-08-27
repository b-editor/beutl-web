import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  checkoutExpire: vi.fn(),
  checkoutList: vi.fn(),
  checkoutRetrieve: vi.fn(),
  pricesRetrieve: vi.fn(),
  activateBillingOffer: vi.fn(),
  bindTopUpCheckoutCreation: vi.fn(),
  bindProCheckoutSession: vi.fn(),
  claimTopUpCheckoutCreation: vi.fn(),
  expireTopUpCheckoutAttempt: vi.fn(),
  createOrRetrieveOwnedCustomerId: vi.fn(),
  deleteBoundProCheckoutAttempt: vi.fn(),
  findBillingOfferById: vi.fn(),
  getOrCreateTopUpCheckoutAttempt: vi.fn(),
  getOrCreateProCheckoutAttempt: vi.fn(),
  getSubscriptionByUserId: vi.fn(),
  setTopUpCheckoutSession: vi.fn(),
  setProCheckoutAttemptParams: vi.fn(),
  portalCreate: vi.fn(),
  portalConfigurationRetrieve: vi.fn(),
  invoicePaymentList: vi.fn(),
  recordBillingRefundCancellation: vi.fn(),
  releaseTopUpCheckoutCreation: vi.fn(),
  scheduleBillingRefundAttempt: vi.fn(),
  startRetryableTransaction: vi.fn(),
  subscriptionCancel: vi.fn(),
  subscriptionList: vi.fn(),
  subscriptionRetrieve: vi.fn(),
  throwIfUnauth: vi.fn(),
  topUpAttempt: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth-guard", () => ({
  throwIfUnauth: mocks.throwIfUnauth,
}));
vi.mock("@/lib/customer", () => ({
  createOrRetrieveOwnedCustomerId:
    mocks.createOrRetrieveOwnedCustomerId,
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    checkout: {
      sessions: {
        create: mocks.checkoutCreate,
        expire: mocks.checkoutExpire,
        list: mocks.checkoutList,
        retrieve: mocks.checkoutRetrieve,
      },
    },
    billingPortal: {
      configurations: { retrieve: mocks.portalConfigurationRetrieve },
      sessions: { create: mocks.portalCreate },
    },
    invoicePayments: { list: mocks.invoicePaymentList },
    subscriptions: {
      cancel: mocks.subscriptionCancel,
      list: mocks.subscriptionList,
      retrieve: mocks.subscriptionRetrieve,
    },
    prices: { retrieve: mocks.pricesRetrieve },
  }),
}));
vi.mock("@beutl/db", () => ({
  activateBillingOffer: mocks.activateBillingOffer,
  bindTopUpCheckoutCreation: mocks.bindTopUpCheckoutCreation,
  bindProCheckoutSession: mocks.bindProCheckoutSession,
  claimTopUpCheckoutCreation: mocks.claimTopUpCheckoutCreation,
  deleteBoundProCheckoutAttempt: mocks.deleteBoundProCheckoutAttempt,
  expireTopUpCheckoutAttempt: mocks.expireTopUpCheckoutAttempt,
  findBillingOfferById: mocks.findBillingOfferById,
  getOrCreateTopUpCheckoutAttempt: mocks.getOrCreateTopUpCheckoutAttempt,
  getOrCreateProCheckoutAttempt: mocks.getOrCreateProCheckoutAttempt,
  getSubscriptionByUserId: mocks.getSubscriptionByUserId,
  recordBillingRefundCancellation: mocks.recordBillingRefundCancellation,
  releaseTopUpCheckoutCreation: mocks.releaseTopUpCheckoutCreation,
  scheduleBillingRefundAttempt: mocks.scheduleBillingRefundAttempt,
  setTopUpCheckoutSession: mocks.setTopUpCheckoutSession,
  setProCheckoutAttemptParams: mocks.setProCheckoutAttemptParams,
  startRetryableTransaction: mocks.startRetryableTransaction,
}));
import {
  createBillingPortalLink,
  createCreditCheckout,
  createPaymentMethodPortalLink,
  createProCheckout,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/billing/actions";

function topUpCheckoutSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "cs_topup",
    mode: "payment",
    status: "open",
    customer: "cus_1",
    amount_total: 1_000,
    currency: "usd",
    expires_at: Math.floor(Date.now() / 1_000) + 86_400,
    url: "https://checkout.stripe.com/topup",
    metadata: {
      beutlApplication: "beutl-web",
      beutlUserId: "user-1",
      creditAmount: "500",
      billingOfferId: "offer_top_up",
      topUpAttemptId: "topup-attempt-1",
    },
    line_items: {
      data: [{ quantity: 1, price: { id: "price_credits" } }],
    },
    ...overrides,
  };
}

describe("AI checkout actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setProCheckoutAttemptParams.mockResolvedValue({ count: 1 });
    process.env.PUBLIC_ORIGIN = "https://beutl.example";
    process.env.STRIPE_CREDIT_PRICE_ID = "price_credits";
    process.env.STRIPE_PRO_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "";
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "bpc_safe";
    mocks.throwIfUnauth.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.com",
      },
    });
    mocks.createOrRetrieveOwnedCustomerId.mockResolvedValue("cus_1");
    mocks.portalConfigurationRetrieve.mockResolvedValue({
      id: "bpc_safe",
      active: true,
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: { enabled: false },
      },
    });
    mocks.subscriptionList.mockResolvedValue({ data: [] });
    mocks.invoicePaymentList.mockResolvedValue({ data: [], has_more: false });
    mocks.pricesRetrieve.mockImplementation(async (priceId: string) =>
      priceId === "price_pro"
        ? {
            id: priceId,
            active: true,
            type: "recurring",
            unit_amount: 2_000,
            currency: "usd",
            product: "prod_pro",
            recurring: { interval: "month", interval_count: 1 },
          }
        : {
            id: priceId,
            active: true,
            type: "one_time",
            unit_amount: 1_000,
            currency: "usd",
            product: "prod_top_up",
            recurring: null,
          },
    );
    mocks.activateBillingOffer.mockImplementation(async ({ terms }) => ({
      ...terms,
      id: terms.kind === "pro" ? "offer_pro" : "offer_top_up",
      checkoutEnabled: true,
    }));
    mocks.findBillingOfferById.mockImplementation(async ({ id }) => ({
      id,
      kind: id === "offer_top_up" ? "top_up" : "pro",
      stripePriceId: id === "offer_pro"
        ? "price_pro"
        : id === "offer_top_up" ? "price_credits" : "price_old",
      stripeProductId: id === "offer_pro"
        ? "prod_pro"
        : id === "offer_top_up" ? "prod_top_up" : "prod_old",
      unitAmount: id === "offer_top_up" ? 1_000 : 2_000,
      currency: "usd",
      creditAmount: id === "offer_top_up" ? 500 : null,
      recurringInterval: id === "offer_top_up" ? null : "month",
      recurringIntervalCount: id === "offer_top_up" ? null : 1,
      checkoutEnabled: id === "offer_pro",
    }));
    mocks.getOrCreateProCheckoutAttempt.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-1",
      billingOfferId: "offer_pro",
      stripeCheckoutSessionId: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const topUpParams = {
      customer: "cus_1",
      mode: "payment",
      line_items: [{ price: "price_credits", quantity: 1 }],
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        creditAmount: "500",
        billingOfferId: "offer_top_up",
        topUpAttemptId: "topup-attempt-1",
      },
      payment_intent_data: {
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
          creditAmount: "500",
          billingOfferId: "offer_top_up",
          topUpAttemptId: "topup-attempt-1",
        },
      },
      invoice_creation: { enabled: true },
      success_url: "https://beutl.example/dashboard/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://beutl.example/dashboard/account/billing",
    };
    const topUpAttempt = {
      id: "topup-attempt-1",
      ownerUserId: "user-1",
      activeOwnerKey: "user-1",
      checkoutKey: "ai-top-up-checkout:topup-attempt-1",
      stripeCustomerId: "cus_1",
      billingOfferId: "offer_top_up",
      stripeCheckoutSessionId: null,
      status: "open",
      paramsJson: JSON.stringify(topUpParams),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    mocks.topUpAttempt = topUpAttempt;
    mocks.getOrCreateTopUpCheckoutAttempt.mockImplementation(
      async () => mocks.topUpAttempt,
    );
    mocks.claimTopUpCheckoutCreation.mockImplementation(async () => ({
      status: "claimed",
      attempt: mocks.topUpAttempt,
    }));
    mocks.bindTopUpCheckoutCreation.mockImplementation(
      async ({ stripeCheckoutSessionId }: { stripeCheckoutSessionId: string }) => {
        if (mocks.topUpAttempt) {
          mocks.topUpAttempt.stripeCheckoutSessionId = stripeCheckoutSessionId;
        }
        return "stored-for-checkout";
      },
    );
    mocks.releaseTopUpCheckoutCreation.mockResolvedValue({ count: 0 });
    mocks.expireTopUpCheckoutAttempt.mockResolvedValue({ count: 1 });
    mocks.checkoutList.mockResolvedValue({ data: [], has_more: false });
    mocks.setTopUpCheckoutSession.mockResolvedValue("stored-for-checkout");
    mocks.bindProCheckoutSession.mockResolvedValue("bound");
    mocks.deleteBoundProCheckoutAttempt.mockResolvedValue(true);
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_1",
      mode: "payment",
      status: "open",
      customer: "cus_1",
      amount_total: 1_000,
      currency: "usd",
      metadata: topUpParams.metadata,
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
      url: "https://checkout.stripe.com/session",
    });
    mocks.checkoutExpire.mockResolvedValue({ id: "cs_1", status: "expired" });
    mocks.subscriptionCancel.mockResolvedValue({
      id: "sub_old",
      customer: "cus_1",
      status: "canceled",
    });
    mocks.scheduleBillingRefundAttempt.mockResolvedValue({ id: "bra_1" });
    mocks.recordBillingRefundCancellation.mockResolvedValue(true);
    mocks.startRetryableTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({ transaction: true }),
    );
  });

  it("copies Pro metadata to the Stripe Subscription", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        success_url:
          "https://beutl.example/dashboard/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        subscription_data: {
          metadata: {
            beutlApplication: "beutl-web",
            beutlUserId: "user-1",
            planId: "pro",
            billingOfferId: "offer_pro",
          },
        },
      }),
      {
        idempotencyKey: "ai-pro-checkout:attempt-1",
      },
    );
    expect(mocks.bindProCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        checkoutKey: "attempt-1",
        stripeCheckoutSessionId: "cs_1",
      }),
    );
  });

  it("copies the top-up amount to the Stripe PaymentIntent", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodEnd: new Date(Date.now() + 60_000),
    });

    await expect(createCreditCheckout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        payment_intent_data: {
          metadata: {
            beutlApplication: "beutl-web",
            beutlUserId: "user-1",
            creditAmount: "500",
            billingOfferId: "offer_top_up",
            topUpAttemptId: "topup-attempt-1",
          },
        },
      }),
      {
        idempotencyKey: "ai-top-up-checkout:topup-attempt-1",
        timeout: 20_000,
        maxNetworkRetries: 2,
      },
    );
  });

  it("recovers a normal top-up after Stripe committed but the response was lost", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodEnd: new Date(Date.now() + 60_000),
    });
    const remote = topUpCheckoutSession();
    let remoteVisible = false;
    mocks.checkoutList.mockImplementation(async ({ status }) => ({
      data: remoteVisible && status === "open" ? [remote] : [],
      has_more: false,
    }));
    mocks.checkoutCreate.mockImplementationOnce(async () => {
      remoteVisible = true;
      throw new Error("connection closed after Stripe committed");
    });
    mocks.checkoutRetrieve.mockResolvedValue(remote);

    await expect(createCreditCheckout()).rejects.toThrow(
      "connection closed after Stripe committed",
    );
    await expect(createCreditCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(mocks.bindTopUpCheckoutCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "topup-attempt-1",
        stripeCheckoutSessionId: "cs_topup",
      }),
    );
  });

  it("serializes concurrent first creates through the durable create lease", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodEnd: new Date(Date.now() + 60_000),
    });
    let leased = false;
    mocks.claimTopUpCheckoutCreation.mockImplementation(async () => {
      if (leased) return { status: "busy" };
      leased = true;
      return { status: "claimed", attempt: mocks.topUpAttempt };
    });
    mocks.checkoutCreate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return topUpCheckoutSession({ id: "cs_concurrent" });
    });
    mocks.bindTopUpCheckoutCreation.mockImplementation(async ({
      stripeCheckoutSessionId,
    }) => {
      mocks.topUpAttempt!.stripeCheckoutSessionId = stripeCheckoutSessionId;
      return "stored-for-checkout";
    });
    mocks.checkoutRetrieve.mockResolvedValue(
      topUpCheckoutSession({ id: "cs_concurrent" }),
    );

    const results = await Promise.allSettled([
      createCreditCheckout(),
      createCreditCheckout(),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(mocks.claimTopUpCheckoutCreation).toHaveBeenCalledTimes(2);
  });

  it("discovers every page before rotating an attempt past retention", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodEnd: new Date(Date.now() + 60_000),
    });
    const old = {
      ...mocks.topUpAttempt!,
      id: "topup-old",
      checkoutKey: "ai-top-up-checkout:topup-old",
      paramsJson: (mocks.topUpAttempt!.paramsJson as string)
        .replaceAll("topup-attempt-1", "topup-old"),
      createdAt: new Date(Date.now() - 24 * 60 * 60_000 - 1),
      recoveryLastError: `absence:topup-old:${new Date(
        Date.now() - 5 * 60_000 - 1,
      ).toISOString()}`,
    };
    const current = mocks.topUpAttempt!;
    mocks.getOrCreateTopUpCheckoutAttempt
      .mockResolvedValueOnce(old)
      .mockResolvedValue(current);
    mocks.claimTopUpCheckoutCreation.mockImplementation(async ({ attemptId }) => ({
      status: "claimed",
      attempt: attemptId === "topup-old" ? old : current,
    }));
    mocks.checkoutList.mockImplementation(async ({ status, starting_after }) => {
      if (status === "open" && !starting_after) {
        return {
          data: [topUpCheckoutSession({
            id: "cs_unrelated",
            metadata: { topUpAttemptId: "another-attempt" },
          })],
          has_more: true,
        };
      }
      return { data: [], has_more: false };
    });

    await expect(createCreditCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.checkoutList).toHaveBeenCalledWith(
      expect.objectContaining({ starting_after: "cs_unrelated" }),
    );
    expect(mocks.expireTopUpCheckoutAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "topup-old", leaseToken: expect.any(String) }),
    );
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(mocks.checkoutCreate.mock.calls[0]?.[1]?.idempotencyKey).toBe(
      "ai-top-up-checkout:topup-attempt-1",
    );
  });

  it("requires two exhaustive absence observations after retention", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodEnd: new Date(Date.now() + 60_000),
    });
    const old = {
      ...mocks.topUpAttempt!,
      id: "topup-unconfirmed-absence",
      checkoutKey: "ai-top-up-checkout:topup-unconfirmed-absence",
      paramsJson: (mocks.topUpAttempt!.paramsJson as string)
        .replaceAll("topup-attempt-1", "topup-unconfirmed-absence"),
      createdAt: new Date(Date.now() - 24 * 60 * 60_000 - 1),
      recoveryLastError: null,
    };
    mocks.getOrCreateTopUpCheckoutAttempt.mockResolvedValue(old);
    mocks.claimTopUpCheckoutCreation.mockResolvedValue({
      status: "claimed",
      attempt: old,
    });
    mocks.checkoutList.mockResolvedValue({ data: [], has_more: false });

    await expect(createCreditCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.expireTopUpCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    expect(mocks.releaseTopUpCheckoutCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "topup-unconfirmed-absence",
        lastError: expect.stringMatching(/^absence:topup-unconfirmed-absence:/),
        notBefore: expect.any(Date),
      }),
    );
  });

  it("fails closed when exhaustive discovery finds multiple remote Sessions", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodEnd: new Date(Date.now() + 60_000),
    });
    mocks.checkoutList.mockImplementation(async ({ status }) => ({
      data: status === "open"
        ? [
            topUpCheckoutSession({ id: "cs_duplicate_a" }),
            topUpCheckoutSession({ id: "cs_duplicate_b" }),
          ]
        : [],
      has_more: false,
    }));

    await expect(createCreditCheckout()).rejects.toThrow(
      "Multiple Stripe Checkout Sessions",
    );

    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    expect(mocks.releaseTopUpCheckoutCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "topup-attempt-1",
        lastError: expect.stringContaining("Multiple Stripe Checkout Sessions"),
      }),
    );
  });

  it("does not let a user without active Pro buy top-up credits", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);

    await expect(createCreditCheckout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("reuses one idempotency key for concurrent Pro checkout requests", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);

    const results = await Promise.allSettled([
      createProCheckout(),
      createProCheckout(),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(2);
    expect(
      mocks.checkoutCreate.mock.calls.map((call) => call[1]?.idempotencyKey),
    ).toEqual([
      "ai-pro-checkout:attempt-1",
      "ai-pro-checkout:attempt-1",
    ]);
  });

  it("reuses an open Checkout bound to an explicitly authorized historical offer", async () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_v2";
    process.env.STRIPE_PRO_HISTORICAL_OFFERS = "price_old:prod_old";
    mocks.pricesRetrieve.mockResolvedValue({
      id: "price_pro_v2",
      active: true,
      type: "recurring",
      unit_amount: 2_000,
      currency: "usd",
      product: "prod_pro_v2",
      recurring: { interval: "month", interval_count: 1 },
    });
    mocks.getOrCreateProCheckoutAttempt.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-old",
      billingOfferId: "offer_old",
      stripeCheckoutSessionId: "cs_old",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_old",
      customer: "cus_1",
      mode: "subscription",
      status: "open",
      url: "https://checkout.stripe.com/historical",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_old",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_old" } }],
      },
    });

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutRetrieve).toHaveBeenCalledWith("cs_old", {
      expand: ["line_items.data.price"],
    });
    expect(mocks.checkoutExpire).not.toHaveBeenCalled();
    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("revalidates an open bound Checkout after its local expiry", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.getOrCreateProCheckoutAttempt.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-expired-cache",
      billingOfferId: "offer_pro",
      stripeCheckoutSessionId: "cs_still_open",
      expiresAt: new Date(Date.now() - 1),
    });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_still_open",
      customer: "cus_1",
      mode: "subscription",
      status: "open",
      url: "https://checkout.stripe.com/still-open",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_pro" } }],
      },
    });

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.checkoutRetrieve).toHaveBeenCalledWith("cs_still_open", {
      expand: ["line_items.data.price"],
    });
    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("expires an unauthorized open historical Checkout and creates the current offer", async () => {
    mocks.getOrCreateProCheckoutAttempt
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-old",
        billingOfferId: "offer_old",
        stripeCheckoutSessionId: "cs_old",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-current",
        billingOfferId: "offer_pro",
        stripeCheckoutSessionId: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_old",
      customer: "cus_1",
      mode: "subscription",
      status: "open",
      url: "https://checkout.stripe.com/old",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_old",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_old" } }],
      },
    });
    mocks.checkoutExpire.mockResolvedValue({ id: "cs_old", status: "expired" });

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutExpire).toHaveBeenCalledWith("cs_old");
    expect(mocks.deleteBoundProCheckoutAttempt).toHaveBeenCalledWith({
      userId: "user-1",
      checkoutKey: "attempt-old",
      stripeCheckoutSessionId: "cs_old",
    });
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pro", quantity: 1 }],
      }),
      expect.any(Object),
    );
    expect(mocks.scheduleBillingRefundAttempt).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "durably compensates an unauthorized completed Checkout%s",
    async (completedDuringExpire) => {
      const openSession = {
        id: "cs_old",
        customer: "cus_1",
        mode: "subscription",
        status: "open",
        url: "https://checkout.stripe.com/old",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
          planId: "pro",
          billingOfferId: "offer_old",
        },
        line_items: {
          data: [{ quantity: 1, price: { id: "price_old" } }],
        },
      };
      const completedSession = {
        ...openSession,
        status: "complete",
        payment_status: "paid",
        subscription: "sub_old",
        invoice: "in_old",
        url: null,
      };
      mocks.getOrCreateProCheckoutAttempt
        .mockResolvedValueOnce({
          userId: "user-1",
          checkoutKey: "attempt-old",
          billingOfferId: "offer_old",
          stripeCheckoutSessionId: "cs_old",
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          checkoutKey: "attempt-current",
          billingOfferId: "offer_pro",
          stripeCheckoutSessionId: null,
          expiresAt: new Date(Date.now() + 86_400_000),
        });
      if (completedDuringExpire) {
        mocks.checkoutRetrieve
          .mockResolvedValueOnce(openSession)
          .mockResolvedValueOnce(completedSession);
        mocks.checkoutExpire.mockRejectedValueOnce(
          new Error("Checkout Session already completed"),
        );
      } else {
        mocks.checkoutRetrieve.mockResolvedValueOnce(completedSession);
      }
      mocks.subscriptionRetrieve.mockResolvedValue({
        id: "sub_old",
        customer: "cus_1",
        status: "active",
        latest_invoice: "in_old",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
          planId: "pro",
          billingOfferId: "offer_old",
        },
        items: {
          data: [{
            quantity: 1,
            price: {
              id: "price_old",
              product: "prod_old",
              unit_amount: 2_000,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
            },
          }],
        },
      });
      mocks.invoicePaymentList.mockResolvedValue({
        data: [{
          id: "ip_old",
          amount_paid: 2_000,
          payment: { type: "payment_intent", payment_intent: "pi_old" },
        }],
        has_more: false,
      });

      await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");

      expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledWith({
        disposition: "superseded-pro-checkout",
        sourceKey: "cs_old:pi_old",
        stripeCustomerId: "cus_1",
        stripeCheckoutSessionId: "cs_old",
        stripeSubscriptionId: "sub_old",
        stripeInvoiceId: "in_old",
        stripePaymentIntentId: "pi_old",
        prisma: { transaction: true },
      });
      expect(mocks.subscriptionCancel).toHaveBeenCalled();
      expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
      expect(mocks.deleteBoundProCheckoutAttempt).toHaveBeenCalledWith({
        userId: "user-1",
        checkoutKey: "attempt-old",
        stripeCheckoutSessionId: "cs_old",
      });
    },
  );

  it("expires a newly created session when its database binding was superseded", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.getOrCreateProCheckoutAttempt
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-stale",
        billingOfferId: "offer_pro",
        stripeCheckoutSessionId: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-current",
        billingOfferId: "offer_pro",
        stripeCheckoutSessionId: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    mocks.checkoutCreate
      .mockResolvedValueOnce({
        id: "cs_stale",
        status: "open",
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        url: "https://checkout.stripe.com/stale",
      })
      .mockResolvedValueOnce({
        id: "cs_current",
        status: "open",
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        url: "https://checkout.stripe.com/current",
      });
    mocks.bindProCheckoutSession
      .mockResolvedValueOnce("superseded")
      .mockResolvedValueOnce("bound");

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.checkoutExpire).toHaveBeenCalledWith("cs_stale");
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(2);
  });

  it("expires a validated session instead of redirecting it when account deletion wins the bind race", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.bindProCheckoutSession.mockResolvedValue(
      "account-deletion-authorized",
    );
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      mode: "subscription",
      status: "open",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_pro" } }],
      },
    });

    const redirectError = await createProCheckout().catch((error) => error);

    expect(redirectError).toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/dashboard/account/billing"),
    });
    expect(mocks.checkoutRetrieve).toHaveBeenCalledWith("cs_1", {
      expand: ["line_items.data.price"],
    });
    expect(mocks.checkoutExpire).toHaveBeenCalledWith("cs_1");
    expect(mocks.deleteBoundProCheckoutAttempt).toHaveBeenCalledWith({
      userId: "user-1",
      checkoutKey: "attempt-1",
      stripeCheckoutSessionId: "cs_1",
    });
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(redirectError.digest).not.toContain(
      "https://checkout.stripe.com/session",
    );
  });

  it("durably compensates a deletion-raced session that completes during expiry", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.bindProCheckoutSession.mockResolvedValue(
      "account-deletion-authorized",
    );
    const openSession = {
      id: "cs_1",
      customer: "cus_1",
      mode: "subscription",
      status: "open",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_pro" } }],
      },
    };
    mocks.checkoutRetrieve
      .mockResolvedValueOnce(openSession)
      .mockResolvedValueOnce({
        ...openSession,
        status: "complete",
        subscription: "sub_raced",
        invoice: "in_raced",
      });
    mocks.checkoutExpire.mockRejectedValueOnce(
      new Error("Checkout Session already completed"),
    );
    mocks.subscriptionRetrieve.mockResolvedValue({
      id: "sub_raced",
      customer: "cus_1",
      status: "active",
      latest_invoice: "in_raced",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
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
    });
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_raced",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_raced" },
      }],
      has_more: false,
    });

    const redirectError = await createProCheckout().catch((error) => error);

    expect(redirectError).toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/dashboard/account/billing"),
    });
    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalledWith({
      disposition: "superseded-pro-checkout",
      sourceKey: "cs_1:pi_raced",
      stripeCustomerId: "cus_1",
      stripeCheckoutSessionId: "cs_1",
      stripeSubscriptionId: "sub_raced",
      stripeInvoiceId: "in_raced",
      stripePaymentIntentId: "pi_raced",
      prisma: { transaction: true },
    });
    expect(mocks.subscriptionCancel).toHaveBeenCalledWith(
      "sub_raced",
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: "beutl:superseded-pro-checkout-cancel:cs_1",
      },
    );
    expect(
      mocks.scheduleBillingRefundAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.deleteBoundProCheckoutAttempt.mock.invocationCallOrder[0],
    );
  });

  it("retains a deletion-raced Checkout when cancellation cannot be recorded", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.bindProCheckoutSession.mockResolvedValue(
      "account-deletion-authorized",
    );
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      mode: "subscription",
      status: "complete",
      subscription: "sub_raced",
      invoice: "in_raced",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_pro" } }],
      },
    });
    mocks.subscriptionRetrieve.mockResolvedValue({
      id: "sub_raced",
      customer: "cus_1",
      status: "active",
      latest_invoice: "in_raced",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
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
    });
    mocks.invoicePaymentList.mockResolvedValue({
      data: [{
        id: "ip_raced",
        amount_paid: 2_000,
        payment: { type: "payment_intent", payment_intent: "pi_raced" },
      }],
      has_more: false,
    });
    mocks.recordBillingRefundCancellation.mockResolvedValue(false);

    const redirectError = await createProCheckout().catch((error) => error);

    expect(redirectError).toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/dashboard/account/billing"),
    });
    expect(mocks.scheduleBillingRefundAttempt).toHaveBeenCalled();
    expect(mocks.subscriptionCancel).toHaveBeenCalledWith(
      "sub_raced",
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: "beutl:superseded-pro-checkout-cancel:cs_1",
      },
    );
    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
  });

  it("retains a deletion-raced Checkout when Stripe cancellation remains active", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.bindProCheckoutSession.mockResolvedValue(
      "account-deletion-authorized",
    );
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_1",
      customer: "cus_1",
      mode: "subscription",
      status: "complete",
      subscription: "sub_raced",
      invoice: "in_raced",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
      line_items: {
        data: [{ quantity: 1, price: { id: "price_pro" } }],
      },
    });
    mocks.subscriptionRetrieve.mockResolvedValue({
      id: "sub_raced",
      customer: "cus_1",
      status: "active",
      latest_invoice: "in_raced",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
        planId: "pro",
        billingOfferId: "offer_pro",
      },
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
    });
    mocks.subscriptionCancel.mockResolvedValue({
      id: "sub_raced",
      status: "active",
    });

    const redirectError = await createProCheckout().catch((error) => error);

    expect(redirectError).toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("/dashboard/account/billing"),
    });
    expect(mocks.recordBillingRefundCancellation).not.toHaveBeenCalled();
    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
  });

  it("does not create a second checkout for a non-terminal Stripe Pro subscription", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.subscriptionList.mockResolvedValue({
      data: [
        {
          status: "incomplete",
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  id: "price_pro",
                  recurring: { interval: "month", interval_count: 1 },
                },
              },
            ],
          },
        },
      ],
    });

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("checks every Stripe subscription page before creating a Pro checkout", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.subscriptionList
      .mockResolvedValueOnce({
        data: [{ id: "sub_old", status: "canceled", items: { data: [] } }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "sub_active",
            status: "active",
            items: {
              data: [
                {
                  quantity: 1,
                  price: {
                    id: "price_pro",
                    recurring: { interval: "month", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        has_more: false,
      });

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.subscriptionList).toHaveBeenNthCalledWith(2, {
      customer: "cus_1",
      status: "all",
      limit: 100,
      starting_after: "sub_old",
    });
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("lets a user resubscribe after a refund canceled the Stripe subscription", async () => {
    // A refund that cancels the subscription in Stripe can leave the local row
    // on its last non-terminal status when no subscription webhook is replayed.
    mocks.getSubscriptionByUserId.mockResolvedValue({
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    mocks.subscriptionList.mockResolvedValue({
      data: [
        {
          id: "sub_refunded",
          status: "canceled",
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  id: "price_pro",
                  recurring: { interval: "month", interval_count: 1 },
                },
              },
            ],
          },
        },
      ],
      has_more: false,
    });

    await expect(createProCheckout()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("does not replace an open bound checkout whose ownership metadata mismatches", async () => {
    mocks.getSubscriptionByUserId.mockResolvedValue(null);
    mocks.getOrCreateProCheckoutAttempt
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-old",
        billingOfferId: "offer_pro",
        stripeCheckoutSessionId: "cs_unowned",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        checkoutKey: "attempt-new",
        billingOfferId: "offer_pro",
        stripeCheckoutSessionId: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    mocks.checkoutRetrieve.mockResolvedValue({
      id: "cs_unowned",
      customer: "cus_1",
      status: "open",
      url: "https://checkout.stripe.com/unowned",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "another-user",
      },
    });

    await expect(createProCheckout()).rejects.toThrow(
      "failed validation before its Stripe state was safely resolved",
    );

    expect(mocks.deleteBoundProCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.checkoutExpire).not.toHaveBeenCalled();
    expect(mocks.subscriptionCancel).not.toHaveBeenCalled();
    expect(mocks.scheduleBillingRefundAttempt).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("opens the portal only for the customer returned by owned-customer remediation", async () => {
    mocks.createOrRetrieveOwnedCustomerId.mockResolvedValue("cus_remediated");
    mocks.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.com/session",
    });

    await expect(createBillingPortalLink()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.portalCreate).toHaveBeenCalledWith({
      customer: "cus_remediated",
      configuration: "bpc_safe",
      // The marker lets the plan page read Stripe on return, so a portal
      // cancellation is visible before its webhook arrives.
      return_url:
        "https://beutl.example/dashboard/account/billing?portal=returned",
    });
  });

  it("rejects a portal configuration that permits subscription price switching", async () => {
    mocks.portalConfigurationRetrieve.mockResolvedValue({
      id: "bpc_unsafe",
      active: true,
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: { enabled: true },
      },
    });

    await expect(createBillingPortalLink()).rejects.toThrow(
      "disable subscription switching",
    );
    expect(mocks.portalCreate).not.toHaveBeenCalled();
  });

  it("opens the payment method update flow for the owned customer", async () => {
    mocks.portalConfigurationRetrieve.mockResolvedValue({
      id: "bpc_safe",
      active: true,
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: { enabled: false },
        payment_method_update: { enabled: true },
      },
    });
    mocks.createOrRetrieveOwnedCustomerId.mockResolvedValue("cus_remediated");
    mocks.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.com/payment-method",
    });

    await expect(createPaymentMethodPortalLink()).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(mocks.portalCreate).toHaveBeenCalledWith({
      customer: "cus_remediated",
      configuration: "bpc_safe",
      // The deep link drops the customer straight into the card form instead of
      // the portal home, where the button's label would be a lie.
      flow_data: {
        type: "payment_method_update",
        after_completion: {
          type: "redirect",
          redirect: {
            return_url:
              "https://beutl.example/dashboard/account/billing?portal=returned",
          },
        },
      },
      return_url:
        "https://beutl.example/dashboard/account/billing?portal=returned",
    });
  });

  it("rejects a portal configuration that does not allow payment method updates", async () => {
    mocks.portalConfigurationRetrieve.mockResolvedValue({
      id: "bpc_no_pm",
      active: true,
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: { enabled: false },
        payment_method_update: { enabled: false },
      },
    });

    await expect(createPaymentMethodPortalLink()).rejects.toThrow(
      "must allow payment method updates",
    );
    expect(mocks.portalCreate).not.toHaveBeenCalled();
  });

  // Cancellation must never depend on a feature it does not use. The default
  // mock has no payment_method_update key at all, which is the shape a portal
  // configured only for cancellation returns.
  it("keeps the cancellation portal working when payment method updates are unavailable", async () => {
    mocks.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.com/session",
    });

    await expect(createBillingPortalLink()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.portalCreate).toHaveBeenCalledWith({
      customer: "cus_1",
      configuration: "bpc_safe",
      return_url:
        "https://beutl.example/dashboard/account/billing?portal=returned",
    });
  });
});

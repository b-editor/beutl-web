import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  checkoutExpire: vi.fn(),
  checkoutRetrieve: vi.fn(),
  pricesRetrieve: vi.fn(),
  activateBillingOffer: vi.fn(),
  bindProCheckoutSession: vi.fn(),
  createTopUpCheckoutAttempt: vi.fn(),
  createOrRetrieveOwnedCustomerId: vi.fn(),
  deleteBoundProCheckoutAttempt: vi.fn(),
  findBillingOfferById: vi.fn(),
  getOrCreateProCheckoutAttempt: vi.fn(),
  getSubscriptionByUserId: vi.fn(),
  setTopUpCheckoutSession: vi.fn(),
  portalCreate: vi.fn(),
  portalConfigurationRetrieve: vi.fn(),
  invoicePaymentList: vi.fn(),
  recordBillingRefundCancellation: vi.fn(),
  scheduleBillingRefundAttempt: vi.fn(),
  startRetryableTransaction: vi.fn(),
  subscriptionCancel: vi.fn(),
  subscriptionList: vi.fn(),
  subscriptionRetrieve: vi.fn(),
  throwIfUnauth: vi.fn(),
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
  bindProCheckoutSession: mocks.bindProCheckoutSession,
  createTopUpCheckoutAttempt: mocks.createTopUpCheckoutAttempt,
  deleteBoundProCheckoutAttempt: mocks.deleteBoundProCheckoutAttempt,
  findBillingOfferById: mocks.findBillingOfferById,
  getOrCreateProCheckoutAttempt: mocks.getOrCreateProCheckoutAttempt,
  getSubscriptionByUserId: mocks.getSubscriptionByUserId,
  recordBillingRefundCancellation: mocks.recordBillingRefundCancellation,
  scheduleBillingRefundAttempt: mocks.scheduleBillingRefundAttempt,
  setTopUpCheckoutSession: mocks.setTopUpCheckoutSession,
  startRetryableTransaction: mocks.startRetryableTransaction,
}));
import {
  createBillingPortalLink,
  createCreditCheckout,
  createPaymentMethodPortalLink,
  createProCheckout,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/billing/actions";

describe("AI checkout actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      kind: "pro",
      stripePriceId: id === "offer_pro" ? "price_pro" : "price_old",
      stripeProductId: id === "offer_pro" ? "prod_pro" : "prod_old",
      unitAmount: 2_000,
      currency: "usd",
      creditAmount: null,
      recurringInterval: "month",
      recurringIntervalCount: 1,
      checkoutEnabled: id === "offer_pro",
    }));
    mocks.getOrCreateProCheckoutAttempt.mockResolvedValue({
      userId: "user-1",
      checkoutKey: "attempt-1",
      billingOfferId: "offer_pro",
      stripeCheckoutSessionId: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mocks.createTopUpCheckoutAttempt.mockResolvedValue({
      id: "topup-attempt-1",
      ownerUserId: "user-1",
      stripeCustomerId: "cus_1",
      billingOfferId: "offer_top_up",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mocks.setTopUpCheckoutSession.mockResolvedValue(true);
    mocks.bindProCheckoutSession.mockResolvedValue("bound");
    mocks.deleteBoundProCheckoutAttempt.mockResolvedValue(true);
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_1",
      status: "open",
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
      { idempotencyKey: "ai-top-up-checkout:topup-attempt-1" },
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

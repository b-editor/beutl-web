import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@beutl/db", () => ({
  scheduleStripeCheckoutCleanup: vi.fn().mockResolvedValue({ id: "cleanup-1" }),
  setTopUpCheckoutSession: vi.fn().mockResolvedValue("stored-for-refund"),
}));

import { closeStripeCustomerForAdminAccountDeletion } from "../../packages/api/src/account-deletion-stripe";

describe("admin Stripe customer closure", () => {
  beforeEach(async () => {
    const db = await import("@beutl/db");
    vi.clearAllMocks();
    (db.scheduleStripeCheckoutCleanup as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValue({ id: "cleanup-1" });
    (db.setTopUpCheckoutSession as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValue("stored-for-refund");
  });

  it("fails closed when a recent completed Session has no PaymentIntent", async () => {
    const stripe = {
      customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), del: vi.fn() },
      subscriptions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [{ id: "cs_recent", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" }, payment_intent: null }], has_more: false }), expire: vi.fn(), retrieve: vi.fn() } },
      paymentIntents: { retrieve: vi.fn() },
      charges: { retrieve: vi.fn() },
    };
    await expect(closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date("2026-08-25T00:00:00Z"), secretKey: "sk_test", stripeClient: stripe as never })).resolves.toEqual({ status: "owner-mismatch", customerId: "cus_1" });
    expect(stripe.customers.del).not.toHaveBeenCalled();
  });
  it("paginates subscriptions and open Sessions and persists cleanup before expiry", async () => {
    const scheduled = (await import("@beutl/db")).scheduleStripeCheckoutCleanup as unknown as ReturnType<typeof vi.fn>;
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }),
        del: vi.fn().mockResolvedValue({ id: "cus_1", deleted: true }),
      },
      subscriptions: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [{ id: "sub_1", status: "canceled" }], has_more: true })
          .mockResolvedValueOnce({ data: [{ id: "sub_2", status: "canceled" }], has_more: false }),
      },
      checkout: {
          sessions: {
          list: vi.fn()
            .mockResolvedValueOnce({ data: [{ id: "cs_1", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" } }], has_more: true })
            .mockResolvedValueOnce({ data: [{ id: "cs_2", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", billingOfferId: "offer_1" } }], has_more: false })
            .mockResolvedValueOnce({ data: [], has_more: false })
            .mockResolvedValueOnce({ data: [], has_more: false }),
            expire: vi.fn().mockResolvedValue({ status: "expired" }),
        },
      },
    };
    const result = await closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date("2026-08-25T00:00:00Z"), secretKey: "sk_test", stripeClient: stripe as never });
    expect(result).toEqual({ status: "closed", customerId: "cus_1" });
    expect(stripe.checkout.sessions.list).toHaveBeenCalledTimes(4);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveBeenCalledTimes(2);
    expect(stripe.customers.del).toHaveBeenCalledTimes(1);
  });

  it("keeps the durable cleanup handle when a listed Session completes before expiry", async () => {
    const scheduled = (await import("@beutl/db")).scheduleStripeCheckoutCleanup as unknown as ReturnType<typeof vi.fn>;
    const order: string[] = [];
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }),
        del: vi.fn().mockImplementation(async () => { order.push("delete-customer"); return { id: "cus_1", deleted: true }; }),
      },
      subscriptions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: {
        sessions: {
          list: vi.fn()
            .mockResolvedValueOnce({ data: [{ id: "cs_race", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" } }], has_more: false })
            .mockResolvedValueOnce({ data: [], has_more: false })
            .mockResolvedValueOnce({ data: [], has_more: false }),
          expire: vi.fn().mockImplementation(async () => { order.push("expire"); throw new Error("already complete"); }),
      retrieve: vi.fn().mockResolvedValue({ id: "cs_race", status: "complete" }),
        },
      },
    };
    scheduled.mockImplementation(async () => { order.push("schedule"); return { id: "cleanup-race" }; });
    await closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date("2026-08-25T00:00:00Z"), secretKey: "sk_test", stripeClient: stripe as never });
    expect(order.indexOf("schedule")).toBeLessThan(order.indexOf("expire"));
    expect(stripe.customers.del).toHaveBeenCalledTimes(1);
  });

  it("paginates completed Sessions and schedules each owned payment", async () => {
    const scheduled = (await import("@beutl/db")).scheduleStripeCheckoutCleanup as unknown as ReturnType<typeof vi.fn>;
    const metadata = { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" };
    const pageOne = { id: "cs-page-1", metadata, payment_intent: { id: "pi-1" } };
    const pageTwo = { id: "cs-page-2", metadata, payment_intent: { id: "pi-2" } };
    const stripe = {
      customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), del: vi.fn() },
      subscriptions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: { sessions: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [], has_more: false })
          .mockResolvedValueOnce({ data: [pageOne], has_more: true })
          .mockResolvedValueOnce({ data: [pageTwo], has_more: false })
          .mockResolvedValueOnce({ data: [], has_more: false }),
        expire: vi.fn(), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn().mockImplementation(async (id: string) => ({ id, latest_charge: { id: `ch-${id}`, created: 1 } })) },
      charges: { retrieve: vi.fn() },
    };
    await expect(closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date(0), secretKey: "sk_test", stripeClient: stripe as never })).resolves.toEqual({ status: "closed", customerId: "cus_1" });
    expect(stripe.checkout.sessions.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "complete" }));
    expect(stripe.checkout.sessions.list).toHaveBeenNthCalledWith(3, expect.objectContaining({ status: "complete", starting_after: "cs-page-1" }));
    expect(scheduled).toHaveBeenCalledTimes(2);
  });

  it("ignores package/top-up Charges before deletion authorization but schedules the cutoff", async () => {
    const scheduled = (await import("@beutl/db")).scheduleStripeCheckoutCleanup as unknown as ReturnType<typeof vi.fn>;
    const storedTopUp = (await import("@beutl/db")).setTopUpCheckoutSession as unknown as ReturnType<typeof vi.fn>;
    const metadata = { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" };
    const topUpMetadata = { beutlApplication: "beutl-web", beutlUserId: "u1", topUpAttemptId: "topup-1", billingOfferId: "offer-1" };
    const stripe = {
      customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), del: vi.fn() },
      subscriptions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: { sessions: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [], has_more: false })
          .mockResolvedValueOnce({ data: [
            { id: "cs-before", metadata, payment_intent: { id: "pi-before" } },
            { id: "cs-at", metadata, payment_intent: { id: "pi-at" } },
            { id: "cs-topup-before", metadata: topUpMetadata, payment_intent: { id: "pi-topup-before" } },
            { id: "cs-topup-at", metadata: topUpMetadata, payment_intent: { id: "pi-topup-at" } },
          ], has_more: false })
          .mockResolvedValueOnce({ data: [], has_more: false }),
        expire: vi.fn(), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn().mockImplementation(async (id: string) => ({ id, latest_charge: { id: `ch-${id}`, created: id.endsWith("before") ? 999 : 1_000 } })) },
      charges: { retrieve: vi.fn() },
    };
    await closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date(1_000_000), secretKey: "sk_test", stripeClient: stripe as never });
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "cs-at" }));
    expect(storedTopUp).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "topup-1", stripeCheckoutSessionId: "cs-topup-at" }));
  });

  it("applies the subscription cutoff for Pro completed Sessions", async () => {
    const scheduled = (await import("@beutl/db")).scheduleStripeCheckoutCleanup as unknown as ReturnType<typeof vi.fn>;
    const proMetadata = { beutlApplication: "beutl-web", beutlUserId: "u1", billingOfferId: "offer-1" };
    const stripe = {
      customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), del: vi.fn() },
      subscriptions: {
        retrieve: vi.fn().mockImplementation(async (id: string) => ({ id, created: id === "sub-before" ? 999 : 1_000, status: "canceled" })),
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
      },
      checkout: { sessions: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [], has_more: false })
          .mockResolvedValueOnce({ data: [
            { id: "cs-pro-before", metadata: proMetadata, subscription: "sub-before" },
            { id: "cs-pro-at", metadata: proMetadata, subscription: "sub-at" },
          ], has_more: false })
          .mockResolvedValueOnce({ data: [], has_more: false }),
        expire: vi.fn(), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() }, charges: { retrieve: vi.fn() },
    };
    await closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date(1_000_000), secretKey: "sk_test", stripeClient: stripe as never });
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "cs-pro-at", kind: "pro" }));
  });

  it.each(["paymentIntent", "charge", "subscription"])("fails closed when %s retrieval fails", async (kind) => {
    const metadata = { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: kind === "subscription" ? undefined : "package", packageId: kind === "subscription" ? undefined : "p1", billingOfferId: kind === "subscription" ? "offer-1" : undefined };
    const stripe: any = {
      customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), del: vi.fn() },
      subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error("subscription unavailable")), list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: { sessions: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [], has_more: false })
          .mockResolvedValueOnce({ data: [{ id: "cs-fail", metadata, payment_intent: "pi-fail", subscription: "sub-fail" }], has_more: false }),
        expire: vi.fn(), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: kind === "paymentIntent" ? vi.fn().mockRejectedValue(new Error("PI unavailable")) : vi.fn().mockResolvedValue({ id: "pi-fail", latest_charge: "ch-fail" }) },
      charges: { retrieve: kind === "charge" ? vi.fn().mockRejectedValue(new Error("charge unavailable")) : vi.fn().mockResolvedValue({ id: "ch-fail", created: 1_000 }) },
    };
    await expect(closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date(1_000_000), secretKey: "sk_test", stripeClient: stripe })).resolves.toMatchObject({ status: "owner-mismatch" });
    expect(stripe.customers.del).not.toHaveBeenCalled();
  });

  it("rechecks open Sessions immediately before deleting the Customer", async () => {
    const stripe: any = {
      customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), del: vi.fn() },
      subscriptions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      checkout: { sessions: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [], has_more: false })
          .mockResolvedValueOnce({ data: [], has_more: false })
          .mockResolvedValueOnce({ data: [{ id: "cs-race-open", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1" } }], has_more: false }),
        expire: vi.fn(), retrieve: vi.fn(),
      } },
      paymentIntents: { retrieve: vi.fn() }, charges: { retrieve: vi.fn() },
    };
    await expect(closeStripeCustomerForAdminAccountDeletion({ userId: "u1", stripeCustomerId: "cus_1", deletionAuthorizedAt: new Date("2026-08-25T00:00:00Z"), secretKey: "sk_test", stripeClient: stripe })).resolves.toEqual({ status: "owner-mismatch", customerId: "cus_1" });
    expect(stripe.customers.del).not.toHaveBeenCalled();
  });
});

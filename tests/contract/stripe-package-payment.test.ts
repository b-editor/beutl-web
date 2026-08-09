import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCustomerOwnersByStripeId: vi.fn(),
  findPackage: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  findCustomerOwnersByStripeId: mocks.findCustomerOwnersByStripeId,
  getDb: async () => ({ package: { findFirst: mocks.findPackage } }),
}));

import {
  refundPackagePayment,
  resolvePackagePayment,
} from "../../apps/web/src/lib/stripe/package-payment";
import { packagePaymentIntentMetadata } from "../../apps/web/src/lib/stripe/store-checkout";

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi_package",
    amount: 1_000,
    amount_received: 1_000,
    currency: "usd",
    customer: "cus_1",
    metadata: packagePaymentIntentMetadata("user-1", "package-1"),
    status: "succeeded",
    ...overrides,
  } as never;
}

describe("package PaymentIntent validation", () => {
  const retrieveCustomer = vi.fn();
  const createRefund = vi.fn();
  const stripe = {
    customers: { retrieve: retrieveCustomer },
    refunds: { create: createRefund },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCustomerOwnersByStripeId.mockResolvedValue([
      { userId: "user-1" },
    ]);
    mocks.findPackage.mockResolvedValue({ id: "package-1" });
    retrieveCustomer.mockResolvedValue({
      id: "cus_1",
      deleted: false,
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
      },
    });
    createRefund.mockResolvedValue({ id: "re_1" });
  });

  it("fulfills only a fully paid current package price", async () => {
    await expect(
      resolvePackagePayment({ paymentIntent: paymentIntent(), stripe }),
    ).resolves.toEqual({
      status: "fulfill",
      reference: {
        paymentId: "pi_package",
        packageId: "package-1",
        userId: "user-1",
      },
    });
    expect(mocks.findPackage).toHaveBeenCalledWith({
      where: {
        id: "package-1",
        published: true,
        packagePricing: {
          some: {
            price: 1_000,
            currency: { equals: "usd", mode: "insensitive" },
          },
        },
      },
      select: { id: true },
    });
  });

  it.each([
    [{ amount_received: 999 }, "package, amount, or currency mismatch"],
    [{ status: "processing" }, "package, amount, or currency mismatch"],
  ])("refunds incomplete or invalid billing data", async (overrides, reason) => {
    await expect(
      resolvePackagePayment({
        paymentIntent: paymentIntent(overrides),
        stripe,
      }),
    ).resolves.toEqual({ status: "refund", reason });
  });

  it("refunds a stale or unpublished package price", async () => {
    mocks.findPackage.mockResolvedValue(null);

    await expect(
      resolvePackagePayment({ paymentIntent: paymentIntent(), stripe }),
    ).resolves.toEqual({
      status: "refund",
      reason: "package, amount, or currency mismatch",
    });
  });

  it("refunds a legacy intent without an owner binding", async () => {
    await expect(
      resolvePackagePayment({
        paymentIntent: paymentIntent({ metadata: { packageId: "package-1" } }),
        stripe,
      }),
    ).resolves.toEqual({
      status: "refund",
      reason: "missing package ownership binding",
    });
    expect(retrieveCustomer).not.toHaveBeenCalled();
  });

  it("refunds duplicate or mismatched customer ownership", async () => {
    mocks.findCustomerOwnersByStripeId.mockResolvedValue([
      { userId: "user-1" },
      { userId: "user-2" },
    ]);

    await expect(
      resolvePackagePayment({ paymentIntent: paymentIntent(), stripe }),
    ).resolves.toEqual({
      status: "refund",
      reason: "customer mapping mismatch",
    });
  });

  it("refunds conflicting Stripe customer metadata", async () => {
    retrieveCustomer.mockResolvedValue({
      id: "cus_1",
      deleted: false,
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "another-user",
      },
    });

    await expect(
      resolvePackagePayment({ paymentIntent: paymentIntent(), stripe }),
    ).resolves.toEqual({
      status: "refund",
      reason: "Stripe customer owner mismatch",
    });
  });

  it("ignores PaymentIntents that are not package purchases", async () => {
    await expect(
      resolvePackagePayment({
        paymentIntent: paymentIntent({ metadata: {} }),
        stripe,
      }),
    ).resolves.toEqual({ status: "unrecognized" });
  });

  it("uses an idempotent full refund when validation fails", async () => {
    await refundPackagePayment({
      paymentIntentId: "pi_package",
      reason: "package mismatch",
      stripe,
    });

    expect(createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_package",
        reason: "requested_by_customer",
      }),
      { idempotencyKey: "beutl:package-payment:pi_package:refund" },
    );
  });

  it("accepts a payment that was already fully refunded", async () => {
    createRefund.mockRejectedValueOnce(
      Object.assign(new Error("already refunded"), {
        code: "charge_already_refunded",
      }),
    );

    await expect(
      refundPackagePayment({
        paymentIntentId: "pi_package",
        reason: "package mismatch",
        stripe,
      }),
    ).resolves.toBeUndefined();
  });
});

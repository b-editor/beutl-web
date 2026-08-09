import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAuditLog: vi.fn(),
  constructEvent: vi.fn(),
  findPackagePaymentReference: vi.fn(),
  recordPackagePaymentSucceeded: vi.fn(),
  refundPackagePayment: vi.fn(),
  resolvePackagePayment: vi.fn(),
  resolvePackagePaymentOwner: vi.fn(),
  restorePackagePayment: vi.fn(),
  retrieveCharge: vi.fn(),
  retrieveDispute: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  revokePackagePayment: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: {
    store: {
      paymentRestored: "store.paymentRestored",
      paymentRevoked: "store.paymentRevoked",
      paymentSucceeded: "store.paymentSucceeded",
    },
  },
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    charges: { retrieve: mocks.retrieveCharge },
    disputes: { retrieve: mocks.retrieveDispute },
    paymentIntents: { retrieve: mocks.retrievePaymentIntent },
    webhooks: { constructEvent: mocks.constructEvent },
  }),
}));
vi.mock("@/lib/stripe/package-payment", () => ({
  refundPackagePayment: mocks.refundPackagePayment,
  resolvePackagePayment: mocks.resolvePackagePayment,
  resolvePackagePaymentOwner: mocks.resolvePackagePaymentOwner,
}));
vi.mock("@beutl/db", () => ({
  PACKAGE_PAYMENT_EVENT_RANK: {
    paymentSucceeded: 10,
    disputeRestored: 20,
    disputeRevoked: 30,
    refundSucceeded: 40,
  },
  findPackagePaymentReference: mocks.findPackagePaymentReference,
  recordPackagePaymentSucceeded: mocks.recordPackagePaymentSucceeded,
  restorePackagePayment: mocks.restorePackagePayment,
  revokePackagePayment: mocks.revokePackagePayment,
}));

import { POST } from "../../apps/web/src/app/api/stripe/webhook/route";

const reference = {
  paymentId: "pi_package",
  userId: "user-1",
  packageId: "package-1",
};

function request(): Request {
  return new Request("https://beutl.example/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "signature" },
    body: "{}",
  });
}

function event(type: string, object: object) {
  return {
    id: `evt_${type}`,
    created: 1_786_060_900,
    type,
    data: { object },
  };
}

describe("package payment webhook state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_ENDPOINT_SECRET = "whsec_test";
    mocks.findPackagePaymentReference.mockResolvedValue(null);
    mocks.recordPackagePaymentSucceeded.mockResolvedValue({
      ...reference,
      active: true,
      changed: true,
    });
    mocks.revokePackagePayment.mockResolvedValue({
      ...reference,
      active: false,
      changed: true,
    });
    mocks.restorePackagePayment.mockResolvedValue({
      ...reference,
      active: true,
      changed: true,
    });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_package",
      metadata: {},
    });
  });

  it("records only a validated successful package payment", async () => {
    const paymentIntent = {
      id: "pi_package",
      amount: 1_000,
      currency: "usd",
    };
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", paymentIntent),
    );
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "fulfill",
      reference,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.recordPackagePaymentSucceeded).toHaveBeenCalledWith({
      reference,
      billing: {
        amount: 1_000,
        currency: "usd",
      },
      event: expect.objectContaining({
        id: "evt_payment_intent.succeeded",
        rank: 10,
      }),
    });
  });

  it("uses an idempotent refund for an invalid successful payment", async () => {
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", { id: "pi_package" }),
    );
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "refund",
      reason: "amount mismatch",
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.refundPackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_package",
        reason: "amount mismatch",
      }),
    );
    expect(mocks.recordPackagePaymentSucceeded).not.toHaveBeenCalled();
  });

  it("does not reprocess a payment already recorded before deployment", async () => {
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", { id: "pi_package" }),
    );
    mocks.findPackagePaymentReference.mockResolvedValue(reference);

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.resolvePackagePayment).not.toHaveBeenCalled();
    expect(mocks.refundPackagePayment).not.toHaveBeenCalled();
  });

  it("refunds when the package price changes during fulfillment", async () => {
    const paymentIntent = {
      id: "pi_package",
      amount: 1_000,
      currency: "usd",
    };
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", paymentIntent),
    );
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "fulfill",
      reference,
    });
    mocks.recordPackagePaymentSucceeded.mockResolvedValue(null);

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.refundPackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_package",
        reason: "package price changed before fulfillment",
      }),
    );
  });

  it("revokes package access after a refund", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(reference);
    mocks.constructEvent.mockReturnValue(
      event("charge.refunded", { id: "ch_1" }),
    );
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_1",
      amount_refunded: 1_000,
      payment_intent: "pi_package",
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.revokePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pi_package",
        reason: "charge refunded: ch_1",
        event: expect.objectContaining({ rank: 40 }),
      }),
    );
  });

  it("revokes access while a dispute is open", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(reference);
    mocks.constructEvent.mockReturnValue(
      event("charge.dispute.created", { id: "dp_1" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_1",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "under_review",
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.revokePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pi_package",
        event: expect.objectContaining({ rank: 30 }),
      }),
    );
  });

  it("restores access after a won dispute when no refund remains", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(reference);
    mocks.constructEvent.mockReturnValue(
      event("charge.dispute.closed", { id: "dp_1" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_1",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "won",
    });
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_1",
      amount_refunded: 0,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.restorePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pi_package",
        event: expect.objectContaining({ rank: 20 }),
      }),
    );
  });

  it("does not restore a won dispute after any refund", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(reference);
    mocks.constructEvent.mockReturnValue(
      event("charge.dispute.closed", { id: "dp_1" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_1",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "won",
    });
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_1",
      amount_refunded: 1,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.restorePackagePayment).not.toHaveBeenCalled();
  });

  it("does not change access for a warning inquiry", async () => {
    mocks.constructEvent.mockReturnValue(
      event("charge.dispute.updated", { id: "dp_warning" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_warning",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "warning_under_review",
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.revokePackagePayment).not.toHaveBeenCalled();
    expect(mocks.restorePackagePayment).not.toHaveBeenCalled();
  });
});

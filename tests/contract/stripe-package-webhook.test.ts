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
  listRefunds: vi.fn(),
  retrieveCharge: vi.fn(),
  retrieveDispute: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  retrieveRefund: vi.fn(),
  revokePackagePayment: vi.fn(),
}));

vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: {
    store: {
      paymentRestored: "store.paymentRestored",
      paymentRevoked: "store.paymentRevoked",
      paymentRefundFailed: "store.paymentRefundFailed",
      paymentRefundRequiresAction: "store.paymentRefundRequiresAction",
      paymentSucceeded: "store.paymentSucceeded",
    },
  },
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    charges: { retrieve: mocks.retrieveCharge },
    disputes: { retrieve: mocks.retrieveDispute },
    paymentIntents: { retrieve: mocks.retrievePaymentIntent },
    refunds: {
      list: mocks.listRefunds,
      retrieve: mocks.retrieveRefund,
    },
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
    disputeRevoked: 20,
    disputeRestored: 30,
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
const validatedReference = {
  ...reference,
  fulfillmentValidated: true,
};
const tombstoneReference = {
  ...reference,
  fulfillmentValidated: false,
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
    mocks.listRefunds.mockResolvedValue({ data: [], has_more: false });
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
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.resolvePackagePayment).not.toHaveBeenCalled();
    expect(mocks.refundPackagePayment).not.toHaveBeenCalled();
  });

  it("validates a reversal tombstone when success arrives late", async () => {
    const paymentIntent = {
      id: "pi_package",
      amount: 1_000,
      currency: "usd",
    };
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", paymentIntent),
    );
    mocks.findPackagePaymentReference.mockResolvedValue(tombstoneReference);
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "fulfill",
      reference,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.resolvePackagePayment).toHaveBeenCalled();
    expect(mocks.recordPackagePaymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ reference }),
    );
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
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
    mocks.constructEvent.mockReturnValue(
      event("charge.refunded", { id: "ch_1" }),
    );
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_1",
      amount_refunded: 1_000,
      payment_intent: "pi_package",
    });
    mocks.listRefunds.mockResolvedValue({
      data: [
        {
          id: "re_1",
          payment_intent: "pi_package",
          status: "succeeded",
        },
      ],
      has_more: false,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.revokePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pi_package",
        reason: "refund succeeded: re_1",
        event: expect.objectContaining({ rank: 40 }),
      }),
    );
  });

  it("finds a succeeded refund on a later page", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
    mocks.constructEvent.mockReturnValue(
      event("charge.refunded", { id: "ch_paged" }),
    );
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_paged",
      amount_refunded: 1_000,
      payment_intent: "pi_package",
    });
    mocks.listRefunds
      .mockResolvedValueOnce({
        data: [{ id: "re_pending", status: "pending" }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "re_succeeded", status: "succeeded" }],
        has_more: false,
      });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.listRefunds).toHaveBeenNthCalledWith(2, {
      charge: "ch_paged",
      limit: 100,
      starting_after: "re_pending",
    });
    expect(mocks.revokePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "refund succeeded: re_succeeded" }),
    );
  });

  it("rejects an empty refund page that claims more results", async () => {
    mocks.constructEvent.mockReturnValue(
      event("charge.refunded", { id: "ch_empty_page" }),
    );
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_empty_page",
      amount_refunded: 1_000,
      payment_intent: "pi_package",
    });
    mocks.listRefunds.mockResolvedValue({ data: [], has_more: true });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect((await POST(request() as never)).status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      "Stripe webhook handler failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("keeps access while an asynchronous refund is pending", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
    mocks.constructEvent.mockReturnValue(
      event("charge.refunded", { id: "ch_pending" }),
    );
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_pending",
      amount_refunded: 1_000,
      payment_intent: "pi_package",
    });
    mocks.listRefunds.mockResolvedValue({
      data: [{ id: "re_pending", status: "pending" }],
      has_more: false,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.revokePackagePayment).not.toHaveBeenCalled();
  });

  it("revokes access when an asynchronous refund later succeeds", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
    mocks.constructEvent.mockReturnValue(
      event("refund.updated", { id: "re_async" }),
    );
    mocks.retrieveRefund.mockResolvedValue({
      id: "re_async",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "succeeded",
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.revokePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pi_package",
        reason: "refund succeeded: re_async",
        event: expect.objectContaining({ rank: 40 }),
      }),
    );
  });

  it.each([
    { eventType: "refund.failed", status: "failed" },
    { eventType: "refund.updated", status: "canceled" },
    { eventType: "refund.updated", status: "requires_action" },
  ])(
    "keeps access when an asynchronous refund reaches $status",
    async ({ eventType, status }) => {
      mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
      mocks.constructEvent.mockReturnValue(
        event(eventType, { id: "re_unsuccessful" }),
      );
      mocks.retrieveRefund.mockResolvedValue({
        id: "re_unsuccessful",
        charge: "ch_1",
        payment_intent: "pi_package",
        status,
      });

      expect((await POST(request() as never)).status).toBe(200);
      expect(mocks.revokePackagePayment).not.toHaveBeenCalled();
      expect(mocks.restorePackagePayment).not.toHaveBeenCalled();
      expect(mocks.addAuditLog).not.toHaveBeenCalled();
    },
  );

  it("retries when an automatic-refund incident cannot be persisted", async () => {
    mocks.constructEvent.mockReturnValue(
      event("refund.failed", { id: "re_automatic" }),
    );
    mocks.retrieveRefund.mockResolvedValue({
      id: "re_automatic",
      charge: "ch_automatic",
      payment_intent: "pi_package",
      status: "failed",
      failure_reason: "insufficient_funds",
      metadata: {
        beutlDisposition: "package-payment-validation-failed",
        beutlDispositionReason: "amount mismatch",
      },
    });
    mocks.addAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect((await POST(request() as never)).status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      "Stripe webhook handler failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("keeps a committed payment when the audit log write fails", async () => {
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", {
        id: "pi_package",
        amount: 1_000,
        currency: "usd",
      }),
    );
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "fulfill",
      reference,
    });
    mocks.addAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.recordPackagePaymentSucceeded).toHaveBeenCalled();
    expect(mocks.refundPackagePayment).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to record package-payment audit log",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it.each([
    {
      action: "store.paymentRefundFailed",
      eventType: "refund.failed",
      status: "failed",
    },
    {
      action: "store.paymentRefundFailed",
      eventType: "refund.updated",
      status: "canceled",
    },
    {
      action: "store.paymentRefundRequiresAction",
      eventType: "refund.updated",
      status: "requires_action",
    },
  ])(
    "persists an intervention when an automatic refund reaches $status",
    async ({ action, eventType, status }) => {
      mocks.constructEvent.mockReturnValue(
        event(eventType, { id: "re_automatic" }),
      );
      mocks.retrieveRefund.mockResolvedValue({
        id: "re_automatic",
        charge: "ch_automatic",
        payment_intent: "pi_package",
        status,
        failure_reason: "insufficient_funds",
        metadata: {
          beutlDisposition: "package-payment-validation-failed",
          beutlDispositionReason: "amount mismatch",
        },
      });

      expect((await POST(request() as never)).status).toBe(200);
      expect(mocks.addAuditLog).toHaveBeenCalledWith({
        userId: null,
        action,
        details: expect.stringContaining(
          `refundId: re_automatic, refundStatus: ${status}`,
        ),
      });
      expect(mocks.revokePackagePayment).not.toHaveBeenCalled();
      expect(mocks.restorePackagePayment).not.toHaveBeenCalled();
    },
  );

  it("revokes access while a dispute is open", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
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
        event: expect.objectContaining({ rank: 20 }),
      }),
    );
  });

  it("restores access after a won dispute when no refund remains", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
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
        event: expect.objectContaining({ rank: 30 }),
      }),
    );
  });

  it("does not restore a won dispute after a succeeded refund", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
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
    mocks.listRefunds.mockResolvedValue({
      data: [{ id: "re_1", status: "succeeded" }],
      has_more: false,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.restorePackagePayment).not.toHaveBeenCalled();
  });

  it("restores a won dispute after an unsuccessful refund", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(validatedReference);
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
    mocks.listRefunds.mockResolvedValue({
      data: [{ id: "re_failed", status: "failed" }],
      has_more: false,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.restorePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pi_package",
        event: expect.objectContaining({ rank: 30 }),
      }),
    );
  });

  it("does not restore an invalid reversal tombstone", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(tombstoneReference);
    mocks.constructEvent.mockReturnValue(
      event("charge.dispute.closed", { id: "dp_tombstone" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_tombstone",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "won",
    });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_package",
      amount: 1_000,
      currency: "usd",
      metadata: {},
    });
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "refund",
      reason: "package, amount, or currency mismatch",
    });
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_1",
      amount_refunded: 0,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.recordPackagePaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.restorePackagePayment).not.toHaveBeenCalled();
  });

  it("revalidates a reversal tombstone before restoring it", async () => {
    mocks.findPackagePaymentReference.mockResolvedValue(tombstoneReference);
    mocks.constructEvent.mockReturnValue(
      event("charge.dispute.closed", { id: "dp_tombstone" }),
    );
    mocks.retrieveDispute.mockResolvedValue({
      id: "dp_tombstone",
      charge: "ch_1",
      payment_intent: "pi_package",
      status: "won",
    });
    mocks.retrievePaymentIntent.mockResolvedValue({
      id: "pi_package",
      amount: 1_000,
      currency: "usd",
      metadata: {},
    });
    mocks.resolvePackagePayment.mockResolvedValue({
      status: "fulfill",
      reference,
    });
    mocks.retrieveCharge.mockResolvedValue({
      id: "ch_1",
      amount_refunded: 0,
    });

    expect((await POST(request() as never)).status).toBe(200);
    expect(mocks.recordPackagePaymentSucceeded).toHaveBeenCalledWith({
      reference,
      billing: { amount: 1_000, currency: "usd" },
      event: expect.objectContaining({ rank: 10 }),
    });
    expect(mocks.restorePackagePayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pi_package" }),
    );
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

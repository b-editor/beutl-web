import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  claim: vi.fn(),
  record: vi.fn(),
  settle: vi.fn(),
  clean: vi.fn(),
  intent: vi.fn(),
  schedule: vi.fn(),
  mapping: vi.fn(),
  create: vi.fn(),
  del: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  listDueStripeCustomerProvisioningCleanups: mocks.listDue,
  claimStripeCustomerProvisioning: mocks.claim,
  recordStripeCustomerProvisioningRemote: mocks.record,
  settleStripeCustomerProvisioning: mocks.settle,
  markStripeCustomerProvisioningCleaned: mocks.clean,
  scheduleStripeCustomerProvisioningCleanup: mocks.schedule,
  findAccountDeletionIntentByUserId: mocks.intent,
  createVerifiedCustomerMappingIfAbsent: mocks.mapping,
}));
vi.mock("stripe", () => ({
  default: class MockStripe {
    customers = { create: mocks.create, del: mocks.del };
  },
}));

import { reconcileStripeCustomerProvisioning } from "../../packages/api/src/stripe-customer-provisioning";

describe("Stripe Customer provisioning reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDue.mockResolvedValue([{ id: "p1", userId: "u1", stripeCustomerId: null, operationKey: "saga1", stripeIdempotencyKey: "op1", paramsJson: JSON.stringify({ metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), attempts: 0 }]);
    mocks.claim.mockResolvedValue({ id: "p1", userId: "u1", stripeCustomerId: null, operationKey: "saga1", stripeIdempotencyKey: "op1", paramsJson: JSON.stringify({ metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), attempts: 1 });
    mocks.create.mockResolvedValue({ id: "cus_1" });
    mocks.intent.mockResolvedValue(null);
    mocks.retrieve.mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } });
  });

  it("replays a response-lost create by stored idempotency key and settles mapping", async () => {
    const result = await reconcileStripeCustomerProvisioning(new Date("2026-08-25T00:00:00Z"), "sk_test", {
      customers: { create: mocks.create, del: mocks.del, retrieve: mocks.retrieve },
    } as never);
    expect(mocks.listDue).toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "op1" });
    expect(mocks.record).toHaveBeenCalledWith({ id: "p1", stripeCustomerId: "cus_1", leaseToken: expect.any(String) });
    expect(result.pending + result.settled + result.cleaned).toBe(1);
  });

  it("replays a cleanup row without a remote ID, then deletes the recovered Customer", async () => {
    mocks.listDue.mockResolvedValue([{ id: "p2", userId: "u1", stripeCustomerId: null, operationKey: "saga2", stripeIdempotencyKey: "op2", status: "cleanup_required", paramsJson: JSON.stringify({ metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), attempts: 1 }]);
    mocks.claim.mockResolvedValue({ id: "p2", userId: "u1", stripeCustomerId: null, operationKey: "saga2", stripeIdempotencyKey: "op2", status: "cleanup_required", paramsJson: JSON.stringify({ metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } }), attempts: 2 });
    mocks.intent.mockResolvedValue({ userId: "u1" });
    mocks.retrieve.mockResolvedValue({ id: "cus_1", deleted: false, metadata: { beutlApplication: "beutl-web", beutlUserId: "u1" } });
    mocks.record.mockResolvedValue({ count: 1 });
    mocks.clean.mockResolvedValue({ count: 1 });
    const result = await reconcileStripeCustomerProvisioning(new Date("2026-08-25T00:00:00Z"), "sk_test", {
      customers: { create: mocks.create, del: mocks.del, retrieve: mocks.retrieve },
    } as never);
    expect(result.pending + result.cleaned).toBe(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "op2" });
    expect(mocks.del).toHaveBeenCalledWith("cus_1", {}, expect.anything());
    expect(result.cleaned).toBe(1);
  });

  it("does not let cron claim a request-owned lease until it expires", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue(null) },
      stripeCustomerProvisioning: {
        findUnique: vi.fn().mockResolvedValue({ id: "p1", leaseExpiresAt: new Date("2026-08-25T01:00:00Z") }),
        upsert: vi.fn().mockResolvedValue({ id: "p1" }),
        updateMany,
        findMany,
      },
    };
    const { beginStripeCustomerProvisioning, claimStripeCustomerProvisioning } = await import("../../packages/db/src/stripe-customer-provisioning");
    await expect(beginStripeCustomerProvisioning({ userId: "u1", operationKey: "op", stripeIdempotencyKey: "op", paramsJson: "{}", now: new Date("2026-08-25T00:00:00Z"), prisma: db as never })).rejects.toThrow("leased");
    await expect(claimStripeCustomerProvisioning({ id: "p1", now: new Date("2026-08-25T00:30:00Z"), leaseToken: "cron", leaseExpiresAt: new Date("2026-08-25T01:30:00Z"), prisma: db as never })).resolves.toBeNull();
  });

  it("blocks a Customer provisioning saga after deletion reservation", async () => {
    const db = {
      accountDeletionIntent: { findFirst: vi.fn().mockResolvedValue({ userId: "u1" }) },
      stripeCustomerProvisioning: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
    };
    const { beginStripeCustomerProvisioning } = await import("../../packages/db/src/stripe-customer-provisioning");
    await expect(beginStripeCustomerProvisioning({ userId: "u1", operationKey: "op", paramsJson: "{}", prisma: db as never })).rejects.toThrow("Account deletion is already authorized");
    expect(db.stripeCustomerProvisioning.upsert).not.toHaveBeenCalled();
  });
});

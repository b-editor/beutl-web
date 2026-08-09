import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  findCustomerByUserId: vi.fn(),
  findCustomerOwnersByStripeId: vi.fn(),
  retrieveCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  upsertCustomerMapping: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  findCustomerByUserId: mocks.findCustomerByUserId,
  findCustomerOwnersByStripeId: mocks.findCustomerOwnersByStripeId,
  upsertCustomerMapping: mocks.upsertCustomerMapping,
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({
    customers: {
      create: mocks.createCustomer,
      retrieve: mocks.retrieveCustomer,
      update: mocks.updateCustomer,
    },
  }),
}));

import { createOrRetrieveCustomerId } from "../../apps/web/src/lib/customer";

describe("Stripe customer ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCustomerByUserId.mockResolvedValue(null);
    mocks.findCustomerOwnersByStripeId.mockResolvedValue([]);
    mocks.createCustomer.mockResolvedValue({ id: "cus_new" });
    mocks.upsertCustomerMapping.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_new",
    });
  });

  it("creates a new owned customer instead of adopting one by email", async () => {
    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_new");

    expect(mocks.createCustomer).toHaveBeenCalledWith(
      {
        email: "user@example.com",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
        },
      },
      { idempotencyKey: "beutl:customer:user-1" },
    );
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
      prisma: undefined,
    });
  });

  it("adopts a uniquely mapped legacy customer by stamping ownership", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_legacy",
    });
    mocks.findCustomerOwnersByStripeId.mockResolvedValue([
      { userId: "user-1" },
    ]);
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_legacy",
      deleted: false,
      email: "old@example.com",
      metadata: {},
    });

    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_legacy");

    expect(mocks.updateCustomer).toHaveBeenCalledWith("cus_legacy", {
      email: "user@example.com",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
      },
    });
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it("replaces a customer shared by multiple local users", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_shared",
    });
    mocks.findCustomerOwnersByStripeId.mockResolvedValue([
      { userId: "user-1" },
      { userId: "user-2" },
    ]);
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_shared",
      deleted: false,
      email: "user@example.com",
      metadata: {},
    });

    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_new");

    expect(mocks.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
        },
      }),
      {
        idempotencyKey: "beutl:customer:user-1:replace:cus_shared",
      },
    );
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
      prisma: undefined,
    });
  });

  it("replaces a mapping with conflicting Stripe owner metadata", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_conflict",
    });
    mocks.findCustomerOwnersByStripeId.mockResolvedValue([
      { userId: "user-1" },
    ]);
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_conflict",
      deleted: false,
      email: "user@example.com",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-2",
      },
    });

    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_new");
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "@beutl/core";

const mocks = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  findCustomerByUserId: vi.fn(),
  retrieveCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  upsertCustomerMapping: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  findCustomerByUserId: mocks.findCustomerByUserId,
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
  async function idempotencyKey(email: string, prefix: string) {
    return `${prefix}:${(await createHash(email)).slice(0, 16)}`;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCustomerByUserId.mockResolvedValue(null);
    mocks.createCustomer.mockResolvedValue({ id: "cus_new" });
    mocks.retrieveCustomer.mockImplementation(async (customerId: string) => ({
      id: customerId,
      deleted: false,
      email: null,
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
      },
    }));
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
      {
        idempotencyKey: await idempotencyKey(
          "user@example.com",
          "beutl:customer:user-1",
        ),
      },
    );
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
    });
  });

  it("replaces a metadata-free legacy mapping instead of claiming it", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_legacy",
    });
    mocks.retrieveCustomer.mockResolvedValueOnce({
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
    ).resolves.toBe("cus_new");

    expect(mocks.updateCustomer).not.toHaveBeenCalledWith(
      "cus_legacy",
      expect.anything(),
    );
    expect(mocks.createCustomer).toHaveBeenCalledWith(
      {
        email: "user@example.com",
        metadata: {
          beutlApplication: "beutl-web",
          beutlUserId: "user-1",
        },
      },
      {
        idempotencyKey: await idempotencyKey(
          "user@example.com",
          "beutl:customer:user-1:replace:cus_legacy",
        ),
      },
    );
  });

  it("reuses a customer with matching Stripe owner metadata", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_owned",
    });
    mocks.retrieveCustomer.mockResolvedValue({
      id: "cus_owned",
      deleted: false,
      email: "old@example.com",
      metadata: {
        beutlApplication: "beutl-web",
        beutlUserId: "user-1",
      },
    });

    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_owned");

    expect(mocks.updateCustomer).toHaveBeenCalledWith("cus_owned", {
      email: "user@example.com",
    });
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it("replaces a customer shared by multiple local users", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_shared",
    });
    mocks.retrieveCustomer.mockResolvedValueOnce({
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
        idempotencyKey: await idempotencyKey(
          "user@example.com",
          "beutl:customer:user-1:replace:cus_shared",
        ),
      },
    );
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
    });
  });

  it("replaces a mapping with conflicting Stripe owner metadata", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_conflict",
    });
    mocks.retrieveCustomer.mockResolvedValueOnce({
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
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
    });
  });

  it("replaces a mapping whose Stripe customer is deleted", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_deleted",
    });
    mocks.retrieveCustomer.mockResolvedValueOnce({
      id: "cus_deleted",
      deleted: true,
    });

    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_new");
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
    });
  });

  it("replaces a mapping whose Stripe customer is missing", async () => {
    mocks.findCustomerByUserId.mockResolvedValue({
      userId: "user-1",
      stripeId: "cus_missing",
    });
    mocks.retrieveCustomer.mockRejectedValueOnce(
      Object.assign(new Error("No such customer"), {
        statusCode: 404,
        code: "resource_missing",
      }),
    );

    await expect(
      createOrRetrieveCustomerId({
        email: "user@example.com",
        userId: "user-1",
      }),
    ).resolves.toBe("cus_new");
    expect(mocks.upsertCustomerMapping).toHaveBeenCalledWith({
      userId: "user-1",
      stripeId: "cus_new",
    });
  });

  it("binds customer idempotency to the email request body", async () => {
    await createOrRetrieveCustomerId({
      email: "user@example.com",
      userId: "user-1",
    });
    await createOrRetrieveCustomerId({
      email: "user@example.com",
      userId: "user-1",
    });
    await createOrRetrieveCustomerId({
      email: "changed@example.com",
      userId: "user-1",
    });

    const keys = mocks.createCustomer.mock.calls.map(
      ([, options]) => options.idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

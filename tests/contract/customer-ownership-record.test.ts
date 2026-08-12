import { beforeEach, describe, expect, it } from "vitest";
import {
  createVerifiedCustomerMappingIfAbsent,
  replaceCustomerMappingWithVerifiedOwnership,
  setDbProvider,
} from "@beutl/db";

describe("verified customer ownership persistence", () => {
  let deletionAuthorized: boolean;
  let customer: { userId: string; stripeId: string } | null;
  let ownerships: Map<
    string,
    {
      stripeId: string;
      userId: string;
      migrationCohort: string | null;
      verifiedAt: Date | null;
    }
  >;

  beforeEach(() => {
    deletionAuthorized = false;
    customer = null;
    ownerships = new Map();
    let transactionTail = Promise.resolve();

    const prisma: any = {
      accountDeletionIntent: {
        findFirst: async () =>
          deletionAuthorized ? { userId: "user-1" } : null,
      },
      customer: {
        findUnique: async ({ where }: any) => {
          if (where.userId) {
            return customer?.userId === where.userId ? { ...customer } : null;
          }
          return customer?.stripeId === where.stripeId ? { ...customer } : null;
        },
        create: async ({ data }: any) => {
          customer = { ...data };
          return { ...customer };
        },
        updateMany: async ({ where, data }: any) => {
          if (
            customer?.userId !== where.userId ||
            customer.stripeId !== where.stripeId
          ) {
            return { count: 0 };
          }
          customer = { ...customer, ...data };
          return { count: 1 };
        },
      },
      stripeCustomerOwnership: {
        findUnique: async ({ where }: any) => {
          const record = ownerships.get(where.stripeId);
          return record ? { ...record } : null;
        },
        create: async ({ data }: any) => {
          const record = {
            migrationCohort: null,
            ...data,
          };
          ownerships.set(record.stripeId, record);
          return { ...record };
        },
        update: async ({ where, data }: any) => {
          const existing = ownerships.get(where.stripeId);
          if (!existing) throw new Error("Ownership not found");
          const updated = { ...existing, ...data };
          ownerships.set(where.stripeId, updated);
          return { ...updated };
        },
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        const previous = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await callback(prisma);
        } finally {
          release();
        }
      },
    };
    setDbProvider(async () => prisma);
  });

  it("converges concurrent creation on one verified mapping", async () => {
    const verifiedAt = new Date("2026-08-09T00:00:00.000Z");
    const results = await Promise.all([
      createVerifiedCustomerMappingIfAbsent({
        userId: "user-1",
        stripeId: "cus_new",
        verifiedAt,
      }),
      createVerifiedCustomerMappingIfAbsent({
        userId: "user-1",
        stripeId: "cus_new",
        verifiedAt,
      }),
    ]);

    expect(results).toEqual([
      { userId: "user-1", stripeId: "cus_new" },
      { userId: "user-1", stripeId: "cus_new" },
    ]);
    expect(customer).toEqual({ userId: "user-1", stripeId: "cus_new" });
    expect([...ownerships.values()]).toEqual([
      {
        stripeId: "cus_new",
        userId: "user-1",
        migrationCohort: null,
        verifiedAt,
      },
    ]);
  });

  it("persists replacement ownership before changing the current mapping", async () => {
    customer = { userId: "user-1", stripeId: "cus_legacy" };
    ownerships.set("cus_legacy", {
      stripeId: "cus_legacy",
      userId: "user-1",
      migrationCohort: "pre-owner-metadata-2026-08-09",
      verifiedAt: null,
    });
    const verifiedAt = new Date("2026-08-09T01:00:00.000Z");

    await expect(
      replaceCustomerMappingWithVerifiedOwnership({
        userId: "user-1",
        expectedStripeId: "cus_legacy",
        stripeId: "cus_new",
        verifiedAt,
      }),
    ).resolves.toEqual({ count: 1 });

    expect(customer).toEqual({ userId: "user-1", stripeId: "cus_new" });
    expect(ownerships.get("cus_legacy")?.migrationCohort).toBe(
      "pre-owner-metadata-2026-08-09",
    );
    expect(ownerships.get("cus_new")).toMatchObject({
      userId: "user-1",
      verifiedAt,
    });
  });

  it("refuses new mappings once account deletion is authorized", async () => {
    deletionAuthorized = true;

    await expect(
      createVerifiedCustomerMappingIfAbsent({
        userId: "user-1",
        stripeId: "cus_new",
      }),
    ).rejects.toThrow("Account deletion is already authorized");
    expect(customer).toBeNull();
    expect(ownerships.size).toBe(0);
  });
});

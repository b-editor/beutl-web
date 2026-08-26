import { describe, expect, it } from "vitest";
import {
  recordPackageCheckoutIntervention,
  packageCheckoutResolutionRefundState,
  schedulePackageCheckoutResolutionRefunds,
} from "../../packages/db/src/package-checkout-resolution";

function prismaStub() {
  const resolutions = new Map<string, any>();
  const refunds = new Map<string, any>();
  const resolutionKey = (where: any) => {
    if (where.id) return [...resolutions.entries()].find(([, row]) => row.id === where.id)?.[0];
    return `${where.attemptId_discoveryToken.attemptId}:${where.attemptId_discoveryToken.discoveryToken}`;
  };
  return {
    resolutions,
    refunds,
    packageCheckoutResolution: {
      create: async ({ data }: any) => { const value = { id: "resolution-1", revision: 0, ...data }; resolutions.set(`${data.attemptId}:${data.discoveryToken}`, value); return value; },
      findUnique: async ({ where }: any) => { const key = resolutionKey(where); return key ? resolutions.get(key) ?? null : null; },
      updateMany: async ({ where, data }: any) => {
        const row = [...resolutions.values()].find((candidate) =>
          (!where.id || candidate.id === where.id) &&
          (where.revision === undefined || candidate.revision === where.revision) &&
          (!where.status || candidate.status === where.status),
        );
        if (!row) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "revision" && value && typeof value === "object" && "increment" in value) row.revision += (value as { increment: number }).increment;
          else row[key] = value;
        }
        return { count: 1 };
      },
    },
    packageCheckoutAttempt: {
      findFirst: async () => ({ id: "attempt-1" }),
    },
    packagePaymentRefundAttempt: {
      findUnique: async ({ where }: any) => refunds.get(where.paymentIntentId) ?? null,
      create: async ({ data }: any) => {
        const value = { id: `refund-${data.paymentIntentId}`, ...data };
        refunds.set(data.paymentIntentId, value);
        return value;
      },
      update: async ({ where, data }: any) => ({ ...(refunds.get(where.id) ?? {}), ...data }),
      findMany: async ({ where }: any) => [...refunds.values()].filter((row) => where.paymentIntentId.in.includes(row.paymentIntentId)),
    },
  } as any;
}

describe("package checkout multiple-session resolution", () => {
  it("uses revision CAS on a concurrent first-create race", async () => {
    const rows = new Map<string, any>();
    let createCalls = 0;
    const table = {
      findUnique: async ({ where }: any) => rows.get(`${where.attemptId_discoveryToken.attemptId}:${where.attemptId_discoveryToken.discoveryToken}`) ?? null,
      create: async ({ data }: any) => {
        createCalls++;
        const key = `${data.attemptId}:${data.discoveryToken}`;
        if (rows.has(key)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        const row = { id: "r1", revision: 0, ...data };
        rows.set(key, row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = [...rows.values()].find((candidate) => candidate.id === where.id && candidate.revision === where.revision);
        if (!row) return { count: 0 };
        Object.assign(row, data, { revision: row.revision + 1 });
        return { count: 1 };
      },
    };
    const prisma = { packageCheckoutResolution: table } as any;
    let gate!: () => void;
    const barrier = new Promise<void>((resolve) => { gate = resolve; });
    let reads = 0;
    table.findUnique = async ({ where }: any) => {
      if (!where.id && reads++ < 2) await barrier;
      return rows.get(`${where.attemptId_discoveryToken.attemptId}:${where.attemptId_discoveryToken.discoveryToken}`) ?? null;
    };
    const first = recordPackageCheckoutIntervention({ attemptId: "a", discoveryToken: "g", canonicalSessionId: "cs", evidenceJson: "{}", prisma });
    const second = recordPackageCheckoutIntervention({ attemptId: "a", discoveryToken: "g", canonicalSessionId: "other", evidenceJson: "{}", prisma });
    gate();
    await expect(Promise.all([first, second])).rejects.toThrow();
    expect(createCalls).toBe(2);
  });
  it("persists canonical identity and schedules unique duplicate refunds", async () => {
    const prisma = prismaStub();
    const row = await schedulePackageCheckoutResolutionRefunds({
      attemptId: "attempt-1",
      discoveryToken: "generation-1",
      canonicalSessionId: "cs-canonical",
      canonicalPaymentIntentId: "pi-canonical",
      recoveryLeaseToken: "lease-1",
      refunds: [
        { paymentIntentId: "pi-duplicate", amount: 500, currency: "USD", customerId: "cus-1", userId: "u-1", packageId: "pkg-1" },
        { paymentIntentId: "pi-duplicate", amount: 500, currency: "USD", customerId: "cus-1", userId: "u-1", packageId: "pkg-1" },
      ],
      evidenceJson: JSON.stringify([{ id: "cs-canonical", status: "complete" }]),
      prisma,
    });
    expect(row).toMatchObject({ canonicalPaymentIntentId: "pi-canonical", status: "refund_pending" });
    expect(prisma.refunds.size).toBe(1);
    expect(await packageCheckoutResolutionRefundState({ attemptId: "attempt-1", discoveryToken: "generation-1", prisma })).toBe("pending");
    prisma.refunds.get("pi-duplicate").status = "refunded";
    expect(await packageCheckoutResolutionRefundState({ attemptId: "attempt-1", discoveryToken: "generation-1", prisma })).toBe("settled");
  });

  it("appends only new refund identities under the current revision", async () => {
    const prisma = prismaStub();
    const first = await schedulePackageCheckoutResolutionRefunds({
      attemptId: "attempt-append", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1",
      canonicalSessionId: "cs", canonicalPaymentIntentId: "pi-c", refunds: [{ paymentIntentId: "pi-1", amount: 500, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }], evidenceJson: "{}", prisma,
    });
    expect(first.revision).toBe(0);
    const second = await schedulePackageCheckoutResolutionRefunds({
      attemptId: "attempt-append", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1", expectedRevision: first.revision,
      canonicalSessionId: "cs", canonicalPaymentIntentId: "pi-c", refunds: [{ paymentIntentId: "pi-1", amount: 500, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }, { paymentIntentId: "pi-2", amount: 500, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }], evidenceJson: "{}", prisma,
    });
    expect(prisma.refunds.size).toBe(2);
  });

  it("keeps an empty refund set appendable until finalization", async () => {
    const prisma = prismaStub();
    const row = await schedulePackageCheckoutResolutionRefunds({
      attemptId: "attempt-empty", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1",
      canonicalSessionId: "cs-canonical", canonicalPaymentIntentId: "pi-canonical", refunds: [], evidenceJson: "{}", prisma,
    });
    expect(row).toMatchObject({ status: "intervention", expectedRefundPaymentIntentIds: "[]", revision: 0 });
    expect(prisma.resolutions.get("attempt-empty:generation-1")).toMatchObject({ status: "intervention" });
  });

  it("reopens a provisional resolved row when a late duplicate refund appears", async () => {
    const prisma = prismaStub();
    prisma.resolutions.set("attempt-late:generation-1", {
      id: "resolution-late", attemptId: "attempt-late", discoveryToken: "generation-1", status: "resolved", revision: 4,
      canonicalSessionId: "cs-canonical", canonicalPaymentIntentId: "pi-canonical", expectedRefundPaymentIntentIds: "[]", evidenceJson: "{}",
    });
    const row = await schedulePackageCheckoutResolutionRefunds({
      attemptId: "attempt-late", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1", expectedRevision: 4,
      canonicalSessionId: "cs-canonical", canonicalPaymentIntentId: "pi-canonical",
      refunds: [{ paymentIntentId: "pi-late", amount: 500, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }], evidenceJson: "{}", prisma,
    });
    expect(row).toMatchObject({ status: "refund_pending", revision: 5, expectedRefundPaymentIntentIds: '["pi-late"]' });
    expect(prisma.resolutions.get("attempt-late:generation-1")).toMatchObject({ status: "refund_pending", revision: 5 });
    expect(prisma.refunds.get("pi-late")).toMatchObject({ status: "required" });
  });

  it("never reopens a terminal resolution", async () => {
    const prisma = prismaStub();
    prisma.resolutions.set("attempt-terminal:generation-1", {
      id: "resolution-terminal", attemptId: "attempt-terminal", discoveryToken: "generation-1", status: "terminal", revision: 2,
      canonicalSessionId: null, canonicalPaymentIntentId: null, expectedRefundPaymentIntentIds: "[]", evidenceJson: "{}",
    });
    await expect(schedulePackageCheckoutResolutionRefunds({
      attemptId: "attempt-terminal", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1", expectedRevision: 2,
      canonicalSessionId: null, canonicalPaymentIntentId: null,
      refunds: [{ paymentIntentId: "pi-late", amount: 500, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }], evidenceJson: "{}", prisma,
    })).rejects.toThrow("status regression");
    expect(prisma.refunds.size).toBe(0);
  });

  it("rejects stale revision and refund-set shrink without mutation", async () => {
    const prisma = prismaStub();
    await schedulePackageCheckoutResolutionRefunds({ attemptId: "attempt-stale", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1", canonicalSessionId: "cs", canonicalPaymentIntentId: "pi-c", refunds: [{ paymentIntentId: "pi-1", amount: 1, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }], evidenceJson: "{}", prisma });
    const before = [...prisma.refunds.keys()];
    await expect(schedulePackageCheckoutResolutionRefunds({ attemptId: "attempt-stale", discoveryToken: "generation-1", recoveryLeaseToken: "lease-1", expectedRevision: 99, canonicalSessionId: "cs", canonicalPaymentIntentId: "pi-c", refunds: [{ paymentIntentId: "pi-1", amount: 1, currency: "usd", customerId: "cus", userId: "u", packageId: "p" }], evidenceJson: "{}", prisma })).rejects.toThrow("revision conflict");
    expect([...prisma.refunds.keys()]).toEqual(before);
  });

  it("rejects malformed evidence instead of storing an unstructured resolution", async () => {
    await expect(recordPackageCheckoutIntervention({
      attemptId: "attempt-2",
      discoveryToken: "generation-2",
      evidenceJson: "not-json",
    })).rejects.toThrow();
  });
});

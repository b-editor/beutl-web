import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@beutl/db";

const runtime = vi.hoisted(() => ({
  nextClientId: 1,
  clients: [] as Array<{
    id: number;
    connectionString: string;
    $disconnect: ReturnType<typeof vi.fn>;
  }>,
  disconnect: vi.fn(async () => {}),
  apiFetch: vi.fn(),
  setR2BucketProvider: vi.fn(),
  abandonStaleStorageUploads: vi.fn(),
  reconcileStorageMultipartCleanups: vi.fn(),
  reconcileAiJobs: vi.fn(),
  reconcileDeletedAccountRemoteJobs: vi.fn(),
  reconcileTopUpRefunds: vi.fn(),
  reconcileTopUpDuplicateRefunds: vi.fn(),
  reconcilePackagePaymentRefunds: vi.fn(),
  reconcileStripeCustomerProvisioning: vi.fn(),
  reconcileStripeCheckoutCleanups: vi.fn(),
  reconcileBillingRefunds: vi.fn(),
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    readonly connectionString: string;

    constructor(options: { connectionString: string }) {
      this.connectionString = options.connectionString;
    }
  },
}));

vi.mock("@prisma/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prisma/client")>();
  return {
    ...actual,
    PrismaClient: class {
      readonly id = runtime.nextClientId++;
      readonly connectionString: string;
      readonly $disconnect = vi.fn(async () => {
        await runtime.disconnect(this.id);
      });

      constructor(options: { adapter: { connectionString: string } }) {
        this.connectionString = options.adapter.connectionString;
        runtime.clients.push(this);
      }
    },
  };
});

vi.mock("@beutl/api", () => ({
  api: { fetch: runtime.apiFetch },
  setR2BucketProvider: runtime.setR2BucketProvider,
  reconcileAiJobs: runtime.reconcileAiJobs,
  reconcileStripeCustomerProvisioning:
    runtime.reconcileStripeCustomerProvisioning,
}));

vi.mock("../../packages/api/src/ai/remote-job-cleanup", () => ({
  reconcileDeletedAccountRemoteJobs:
    runtime.reconcileDeletedAccountRemoteJobs,
}));
vi.mock("../../packages/api/src/ai/billing-refunds", () => ({
  reconcileBillingRefunds: runtime.reconcileBillingRefunds,
}));
vi.mock("../../packages/api/src/ai/top-up-refunds", () => ({
  reconcileTopUpRefunds: runtime.reconcileTopUpRefunds,
}));
vi.mock("../../packages/api/src/ai/package-payment-refunds", () => ({
  reconcilePackagePaymentRefunds: runtime.reconcilePackagePaymentRefunds,
}));
vi.mock("../../packages/api/src/ai/topup-duplicate-refunds", () => ({
  reconcileTopUpDuplicateRefunds: runtime.reconcileTopUpDuplicateRefunds,
}));
vi.mock("../../packages/api/src/ai/stripe-checkout-cleanups", () => ({
  reconcileStripeCheckoutCleanups: runtime.reconcileStripeCheckoutCleanups,
}));
vi.mock("../../packages/api/src/storage-uploads", () => ({
  abandonStaleStorageUploads: runtime.abandonStaleStorageUploads,
  reconcileStorageMultipartCleanups:
    runtime.reconcileStorageMultipartCleanups,
}));

import worker, { type Env } from "../../packages/api/src/worker";

type ScopedClient = Awaited<ReturnType<typeof getDb>> & {
  id: number;
  connectionString: string;
};

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals++;
    if (arrivals === 2) release();
    await released;
  };
}

const reconcilerMocks = [
  runtime.abandonStaleStorageUploads,
  runtime.reconcileStorageMultipartCleanups,
  runtime.reconcileAiJobs,
  runtime.reconcileDeletedAccountRemoteJobs,
  runtime.reconcileTopUpRefunds,
  runtime.reconcileTopUpDuplicateRefunds,
  runtime.reconcilePackagePaymentRefunds,
  runtime.reconcileStripeCustomerProvisioning,
  runtime.reconcileStripeCheckoutCleanups,
  runtime.reconcileBillingRefunds,
];

describe("standalone API Worker database scope", () => {
  beforeEach(() => {
    runtime.nextClientId = 1;
    runtime.clients.length = 0;
    runtime.disconnect.mockReset();
    runtime.disconnect.mockResolvedValue(undefined);
    runtime.apiFetch.mockReset();
    runtime.setR2BucketProvider.mockClear();
    for (const reconciler of reconcilerMocks) reconciler.mockReset();
  });

  it("isolates concurrent fetch events and shares one client within each", async () => {
    const barrier = twoPartyBarrier();
    runtime.apiFetch.mockImplementation(async (request: Request) => {
      const [first, second] = await Promise.all([getDb(), getDb()]) as [
        ScopedClient,
        ScopedClient,
      ];
      await barrier();
      return Response.json({
        scope: new URL(request.url).searchParams.get("scope"),
        first: first.id,
        second: second.id,
        connectionString: first.connectionString,
      });
    });

    const fetchScope = (scope: string) => worker.fetch(
      new Request(`https://beutl.beditor.net/api/v3/test?scope=${scope}`),
      {
        BEUTL_DATABASE_HYPERDRIVE: {
          connectionString: `postgres://${scope}`,
        },
      } satisfies Env,
    );

    const [responseA, responseB] = await Promise.all([
      fetchScope("a"),
      fetchScope("b"),
    ]);
    const resultA = await responseA.json() as {
      first: number;
      second: number;
      connectionString: string;
    };
    const resultB = await responseB.json() as typeof resultA;

    expect(resultA.first).toBe(resultA.second);
    expect(resultB.first).toBe(resultB.second);
    expect(resultA.first).not.toBe(resultB.first);
    expect(resultA.connectionString).toBe("postgres://a");
    expect(resultB.connectionString).toBe("postgres://b");
    expect(runtime.clients).toHaveLength(2);
    await vi.waitFor(() => {
      expect(runtime.clients.every((client) =>
        client.$disconnect.mock.calls.length === 1)).toBe(true);
    });
    expect(runtime.disconnect).toHaveBeenCalledTimes(2);
  });

  it("returns the fetch response when disconnect reports an error", async () => {
    const cleanupError = new Error("disconnect failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime.disconnect.mockRejectedValue(cleanupError);
    runtime.apiFetch.mockImplementation(async () => {
      await getDb();
      return new Response("ok", { status: 202 });
    });

    const response = await worker.fetch(
      new Request("https://beutl.beditor.net/api/v3/test"),
      {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://cleanup" },
      } satisfies Env,
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("ok");
    await vi.waitFor(() =>
      expect(runtime.clients[0].$disconnect).toHaveBeenCalledOnce(),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to disconnect request-scoped PrismaClient",
      cleanupError,
    );
    consoleError.mockRestore();
  });

  it("shares one client across all ten scheduled reconcilers", async () => {
    const observedClientIds: number[] = [];
    for (const reconciler of reconcilerMocks) {
      reconciler.mockImplementation(async () => {
        const client = await getDb() as ScopedClient;
        observedClientIds.push(client.id);
        return { interventionRequired: 0, detachedIntervention: 0 };
      });
    }
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    let scheduledWork: Promise<unknown> | undefined;

    await worker.scheduled(
      { scheduledTime: Date.now() },
      {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://scheduled" },
      } satisfies Env,
      {
        waitUntil(promise) {
          scheduledWork = promise;
        },
      },
    );
    await scheduledWork;

    expect(reconcilerMocks.every((reconciler) =>
      reconciler.mock.calls.length === 1)).toBe(true);
    expect(observedClientIds).toHaveLength(10);
    expect(new Set(observedClientIds)).toEqual(new Set([1]));
    expect(runtime.clients).toHaveLength(1);
    expect(runtime.clients[0].$disconnect).toHaveBeenCalledOnce();
    consoleLog.mockRestore();
  });

  it("drains scheduled siblings before disconnecting after a failure", async () => {
    const failure = new Error("reconciler failed");
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    for (const reconciler of reconcilerMocks) {
      reconciler.mockResolvedValue({
        interventionRequired: 0,
        detachedIntervention: 0,
      });
    }
    runtime.abandonStaleStorageUploads.mockRejectedValue(failure);
    runtime.reconcileAiJobs.mockImplementation(async () => {
      const first = await getDb() as ScopedClient;
      markSlowStarted();
      await slowReleased;
      expect(await getDb()).toBe(first);
      return { interventionRequired: 0, detachedIntervention: 0 };
    });
    let scheduledWork: Promise<unknown> | undefined;

    await worker.scheduled(
      { scheduledTime: Date.now() },
      {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://failure" },
      } satisfies Env,
      {
        waitUntil(promise) {
          scheduledWork = promise;
        },
      },
    );
    await slowStarted;

    expect(runtime.clients[0].$disconnect).not.toHaveBeenCalled();
    releaseSlow();
    await expect(scheduledWork).rejects.toThrow(AggregateError);
    expect(runtime.clients[0].$disconnect).toHaveBeenCalledOnce();
  });
});

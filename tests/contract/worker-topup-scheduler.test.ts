import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  callOrder: [] as string[],
  tick: 0,
  duplicate: vi.fn(),
  packageRefunds: vi.fn(),
  cleanup: vi.fn(),
  storage: vi.fn(),
  jobs: vi.fn(),
  deletedJobs: vi.fn(),
  topUpRefunds: vi.fn(),
  customer: vi.fn(),
  billing: vi.fn(),
  setR2: vi.fn(),
}));

vi.mock("@beutl/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/api")>();
  return {
    ...actual,
    reconcileAiJobs: mocks.jobs,
    reconcileStripeCustomerProvisioning: mocks.customer,
    setR2BucketProvider: mocks.setR2,
  };
});
vi.mock("../../packages/api/src/storage-uploads", () => ({ abandonStaleStorageUploads: mocks.storage }));
vi.mock("../../packages/api/src/ai/remote-job-cleanup", () => ({ reconcileDeletedAccountRemoteJobs: mocks.deletedJobs }));
vi.mock("../../packages/api/src/ai/billing-refunds", () => ({ reconcileBillingRefunds: mocks.billing }));
vi.mock("../../packages/api/src/ai/top-up-refunds", () => ({ reconcileTopUpRefunds: mocks.topUpRefunds }));
vi.mock("../../packages/api/src/ai/package-payment-refunds", () => ({ reconcilePackagePaymentRefunds: mocks.packageRefunds }));
vi.mock("../../packages/api/src/ai/topup-duplicate-refunds", () => ({ reconcileTopUpDuplicateRefunds: mocks.duplicate }));
vi.mock("../../packages/api/src/ai/stripe-checkout-cleanups", () => ({ reconcileStripeCheckoutCleanups: mocks.cleanup }));

import worker, { type Env } from "../../packages/api/src/worker";

const env = {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://scheduler-test" },
  STRIPE_SECRET_KEY: "sk_test_scheduler",
} satisfies Env;

async function runScheduled(tick: number) {
  mocks.tick = tick;
  let pending!: Promise<unknown>;
  await worker.scheduled(
    { scheduledTime: Date.parse(`2026-08-25T00:0${tick}:00.000Z`) },
    env,
    { waitUntil: (promise) => { pending = promise; } },
  );
  await pending;
}

describe("worker scheduled refund/cleanup dependency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.callOrder.length = 0;
    mocks.tick = 0;
    for (const fn of [mocks.storage, mocks.jobs, mocks.deletedJobs, mocks.topUpRefunds, mocks.customer, mocks.billing]) {
      fn.mockResolvedValue({ inspected: 0, interventionRequired: 0 });
    }
    mocks.packageRefunds.mockImplementation(async () => {
      mocks.callOrder.push("package");
      mocks.events.push(`package:start:${mocks.tick}`);
      return { inspected: 0, interventionRequired: 0 };
    });
  });

  it("settles duplicate refunds before cleanup in the same scheduled invocation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let refundState: "none" | "settled" = "none";
    let resolutionState: "none" | "pending" | "resolved" = "none";
    mocks.duplicate.mockImplementation(async () => {
      mocks.callOrder.push("duplicate");
      mocks.events.push(`duplicate:start:${mocks.tick}`);
      if (mocks.tick === 1) {
        resolutionState = "pending";
        mocks.events.push("duplicate:schedule");
      } else {
        refundState = "settled";
        mocks.events.push("duplicate:settled");
      }
      return { inspected: 1, completed: mocks.tick === 2 ? 1 : 0, pending: mocks.tick === 1 ? 1 : 0, interventionRequired: 0 };
    });
    mocks.cleanup.mockImplementation(async () => {
      mocks.callOrder.push("cleanup");
      mocks.events.push(`cleanup:start:${mocks.tick}`);
      if (refundState === "settled") {
        resolutionState = "resolved";
        mocks.events.push("cleanup:bind");
      } else {
        mocks.events.push("cleanup:pending");
      }
      return { inspected: 1, completed: resolutionState === "resolved" ? 1 : 0, pending: resolutionState === "pending" ? 1 : 0, interventionRequired: 0, detachedInspected: 1, detachedRecovered: resolutionState === "resolved" ? 1 : 0, detachedPending: resolutionState === "pending" ? 1 : 0, detachedIntervention: 0 };
    });

    await runScheduled(1);
    expect(resolutionState).toBe("pending");
    expect(mocks.events).toEqual(expect.arrayContaining(["duplicate:schedule", "cleanup:pending"]));

    mocks.events.length = 0;
    mocks.callOrder.length = 0;
    await runScheduled(2);
    expect(refundState).toBe("settled");
    expect(resolutionState).toBe("resolved");
    expect(mocks.events.indexOf("duplicate:settled")).toBeGreaterThanOrEqual(0);
    expect(mocks.events.indexOf("cleanup:bind")).toBeGreaterThan(mocks.events.indexOf("duplicate:settled"));
    expect(mocks.events.indexOf("package:start:2")).toBeLessThan(mocks.events.indexOf("cleanup:start:2"));
    expect(mocks.callOrder.indexOf("cleanup")).toBeGreaterThan(mocks.callOrder.indexOf("duplicate"));
    expect(mocks.callOrder.indexOf("cleanup")).toBeGreaterThan(mocks.callOrder.indexOf("package"));
    const log = logSpy.mock.calls.at(-1);
    expect(log?.[1]).toMatchObject({ topUpDuplicateRefunds: expect.any(Object), stripeCheckoutCleanups: expect.any(Object) });
    vi.restoreAllMocks();
  });
});

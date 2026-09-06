import "server-only";
import { getEntitlements } from "@beutl/api/ai/entitlements";
import { loadAiModelCatalog } from "@beutl/api/ai/model-catalog";
import { getDb, listAiJobsByUserId } from "@beutl/db";
import type { AiAccess, AiBalance } from "./shared";

// Every AI screen needs the same two things from the server: whether the plan
// allows the operation at all, and whether the balance still covers it. Both
// come out of one entitlements read.
export async function getAiScreenState(
  userId: string,
  { videoCapabilities = new Map() }: {
    videoCapabilities?:
      | ReadonlyMap<string, { durations: readonly number[] }>
      | PromiseLike<ReadonlyMap<string, { durations: readonly number[] }>>;
  } = {},
): Promise<{ access: AiAccess; balance: AiBalance }> {
  const prisma = await getDb();
  const catalogPromise = loadAiModelCatalog({ prisma });
  const [entitlements, catalog] = await Promise.all([
    getEntitlements(userId, {
      catalog: catalogPromise,
      prisma,
      videoCapabilities,
    }),
    catalogPromise,
  ]);
  return {
    access: {
      canUseAi: entitlements.canUseAi,
      availability: entitlements.availability,
      // Built here rather than fetched from /ai/capabilities: these pages are
      // server components and can read the catalog directly. Only the id, the
      // label, the tier and the yes/no are carried over — a price on this
      // object would ship to the browser.
      models: Object.fromEntries(
        catalog.operations().map((operation) => [
          operation,
          catalog.list(operation).map((entry) => ({
            id: entry.modelId,
            displayName: entry.displayName,
            costTier: entry.costTier,
            available:
              entitlements.modelAvailability[operation]?.[entry.modelId] ??
              false,
          })),
        ]),
      ),
    },
    balance: {
      usedPercent: entitlements.balance.monthlyUsage.usedPercent,
      remainingPercent: entitlements.balance.monthlyUsage.remainingPercent,
      isExhausted: entitlements.balance.monthlyUsage.isExhausted,
      additionalCredits: entitlements.balance.additionalCredits,
      hasAdditionalCreditDebt: entitlements.balance.hasAdditionalCreditDebt,
      periodEnd: entitlements.currentPeriodEnd,
      // On a cancelled plan the same date is when the plan stops, not when the
      // allowance comes back.
      endsAtPeriodEnd: entitlements.cancelAtPeriodEnd,
    },
  };
}

const ACTIVE_STATUSES = new Set(["queued", "running", "finalizing"]);

// Counted over the most recent page rather than the whole table: this only
// drives a "something is still running" pointer to the history, and a job older
// than the last twenty that is still active is a stuck job, not a normal one.
export async function countActiveAiJobs(userId: string): Promise<number> {
  const page = await listAiJobsByUserId({ userId, limit: 20 });
  return page.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
}

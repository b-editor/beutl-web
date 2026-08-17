import "server-only";
import { getEntitlements } from "@beutl/api";
import { listAiJobsByUserId } from "@beutl/db";
import type { AiAccess, AiBalance } from "./shared";

// Every AI screen needs the same two things from the server: whether the plan
// allows the operation at all, and whether the balance still covers it. Both
// come out of one entitlements read.
export async function getAiScreenState(userId: string): Promise<{
  access: AiAccess;
  balance: AiBalance;
}> {
  const entitlements = await getEntitlements(userId);
  return {
    access: {
      canUseAi: entitlements.canUseAi,
      availability: entitlements.availability,
    },
    balance: {
      usedPercent: entitlements.balance.monthlyUsage.usedPercent,
      remainingPercent: entitlements.balance.monthlyUsage.remainingPercent,
      isExhausted: entitlements.balance.monthlyUsage.isExhausted,
      additionalCredits: entitlements.balance.additionalCredits,
      hasAdditionalCreditDebt: entitlements.balance.hasAdditionalCreditDebt,
      periodEnd: entitlements.currentPeriodEnd,
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

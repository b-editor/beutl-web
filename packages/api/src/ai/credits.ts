import {
  AiUsageLimitExceededError,
  consumeUsage,
  countActiveAiJobsByUserIdAndKind,
  createAiJob,
  findAccountDeletionIntentByUserId,
  getAiJobById,
  getSubscriptionByUserId,
  refundUsage,
  startRetryableTransaction,
  updateActiveAiJobToFailed,
} from "@beutl/db";
import { isActiveProSubscription } from "./entitlements";
import { PRO_PLAN } from "./pricing";

function toUsagePeriod(subscription: {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}) {
  return {
    start: subscription.currentPeriodStart,
    end: subscription.currentPeriodEnd,
  };
}

export async function createReservedAiJob({
  userId,
  kind,
  provider,
  status,
  inputParams,
  usageUnits,
  activeJobLimit,
}: {
  userId: string;
  kind: string;
  provider: string;
  status: "queued" | "running";
  inputParams?: object;
  usageUnits: number;
  activeJobLimit?: number;
}) {
  try {
    const result = await startRetryableTransaction(async (prisma) => {
      if (await findAccountDeletionIntentByUserId({ userId, prisma })) {
        return { outcome: "accountDeletionAuthorized" as const };
      }
      const subscription = await getSubscriptionByUserId({ userId, prisma });
      if (!subscription || !isActiveProSubscription(subscription)) {
        return { outcome: "planRequired" as const };
      }

      if (activeJobLimit !== undefined) {
        const activeJobs = await countActiveAiJobsByUserIdAndKind({
          userId,
          kind,
          prisma,
        });
        if (activeJobs >= activeJobLimit) {
          return { outcome: "jobLimitReached" as const };
        }
      }

      const job = await createAiJob({
        userId,
        kind,
        provider,
        status,
        inputParams,
        usageUnits,
        prisma,
      });
      await consumeUsage({
        userId,
        amount: usageUnits,
        monthlyUsageLimit: PRO_PLAN.monthlyUsageLimit,
        usagePeriod: toUsagePeriod(subscription),
        aiJobId: job.id,
        prisma,
      });
      return { outcome: "reserved" as const, job };
    });

    switch (result.outcome) {
      case "accountDeletionAuthorized":
        return {
          ok: false as const,
          errorCode: "doNotHavePermissions" as const,
          status: 403 as const,
        };
      case "planRequired":
        return {
          ok: false as const,
          errorCode: "aiPlanRequired" as const,
          status: 402 as const,
        };
      case "jobLimitReached":
        return {
          ok: false as const,
          errorCode: "aiJobLimitReached" as const,
          status: 429 as const,
        };
      case "reserved":
        return {
          ok: true as const,
          job: result.job,
        };
    }
  } catch (err) {
    if (err instanceof AiUsageLimitExceededError) {
      return {
        ok: false as const,
        errorCode: "aiUsageLimitExceeded" as const,
        status: 402 as const,
      };
    }
    throw err;
  }
}

export async function failAiJobAndRefundUsage({
  userId,
  aiJobId,
  error,
  expectedProviderJobId,
}: {
  userId: string;
  aiJobId: string;
  error: string;
  expectedProviderJobId?: string | null;
}) {
  await startRetryableTransaction(async (prisma) => {
    const subscription = await getSubscriptionByUserId({ userId, prisma });
    const usagePeriod = subscription
      ? toUsagePeriod(subscription)
      : { start: null, end: null };
    const job = await getAiJobById({ jobId: aiJobId, prisma });
    if (!job || job.userId !== userId) {
      throw new Error(`AI job ${aiJobId} was not found for user ${userId}`);
    }

    if (job.status === "succeeded") {
      return;
    }

    if (job.status !== "failed") {
      const changed = await updateActiveAiJobToFailed({
        jobId: aiJobId,
        error,
        expectedProviderJobId,
        prisma,
      });
      if (!changed) {
        const current = await getAiJobById({ jobId: aiJobId, prisma });
        if (current?.status === "succeeded") {
          return;
        }
        if (
          current?.status === "queued" ||
          current?.status === "running" ||
          current?.status === "finalizing"
        ) {
          // A concurrent owner may have claimed or renewed finalization after
          // the caller read a stale snapshot. Fresh active work must not be
          // refunded out from under that owner.
          return;
        }
        if (current?.status !== "failed") {
          throw new Error(
            `AI job ${aiJobId} cannot transition from ${current?.status ?? "missing"} to failed`,
          );
        }
      }
    }

    await refundUsage({
      userId,
      usagePeriod,
      aiJobId,
      prisma,
    });
  });
}

import {
  AiUsageLimitExceededError,
  consumeUsage,
  countActiveAiJobsByUserIdAndKind,
  createAiJob,
  findAccountDeletionIntentByUserId,
  getAiJobById,
  getAiJobByIdempotency,
  getSubscriptionByUserId,
  refundUsage,
  startRetryableTransaction,
  updateActiveAiJobToFailed,
  failAiJobOwnedByFinalizer,
  failAiJobOwnedByProviderPoll,
} from "@beutl/db";
import { isActiveProSubscription } from "./entitlements";
import { loadAiSettings } from "./settings";

function toUsagePeriod(subscription: {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}) {
  return {
    start: subscription.currentPeriodStart,
    end: subscription.currentPeriodEnd,
  };
}

// その名前で既に作られた job を、今のモデル設定を見る前に引き当てる。
//
// 応答が消えたあとに管理者がモデルを無効化したり、モデルの受け付ける形が変わっ
// たりすると、「今そのリクエストを新しく受けられるか」の判定に引っかかって、
// 支払い済みの結果を取り戻せなくなる。回収は設定より先に試みる。
export async function findReplayableAiJob({
  userId,
  idempotencyKeyHash,
  requestFingerprint,
}: {
  userId: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
}): Promise<
  | { outcome: "existing"; job: NonNullable<Awaited<ReturnType<typeof getAiJobByIdempotency>>> }
  | { outcome: "idempotencyConflict" }
  | { outcome: "deleted" }
  | null
> {
  const existing = await getAiJobByIdempotency({ userId, idempotencyKeyHash });
  if (!existing) return null;
  if (existing.requestFingerprint !== requestFingerprint) {
    return { outcome: "idempotencyConflict" };
  }
  if (existing.deletedAt) return { outcome: "deleted" };
  return { outcome: "existing", job: existing };
}

// その名前の job がこのユーザーに既にあるか。本文を読む前に、契約が切れている
// ことを理由に断ってよいかどうかを決めるために使う。支払い済みの結果は、契約が
// 終わったあとでも取りに来られなければならない。
export async function hasAiJobForIdempotencyKey({
  userId,
  idempotencyKeyHash,
}: {
  userId: string;
  idempotencyKeyHash: string | null;
}): Promise<boolean> {
  if (!idempotencyKeyHash) return false;
  const existing = await getAiJobByIdempotency({ userId, idempotencyKeyHash });
  return existing !== null && !existing.deletedAt;
}

export async function createReservedAiJob({
  userId,
  kind,
  provider,
  status,
  inputParams,
  usageUnits,
  model,
  activeJobLimit,
  idempotencyKeyHash,
  requestFingerprint,
  callbackNonceHash,
}: {
  userId: string;
  kind: string;
  provider: string;
  status: "queued" | "running";
  inputParams?: object;
  usageUnits: number;
  // The model this job was priced for and will run on. Resolved together with
  // the price so the two can never disagree.
  model?: string;
  activeJobLimit?: number;
  idempotencyKeyHash?: string;
  requestFingerprint?: string;
  callbackNonceHash?: string;
}) {
  if ((idempotencyKeyHash === undefined) !== (requestFingerprint === undefined)) {
    throw new TypeError(
      "AI idempotency key hash and request fingerprint must be provided together",
    );
  }
  try {
    const result = await startRetryableTransaction(async (prisma) => {
      if (idempotencyKeyHash && requestFingerprint) {
        const existing = await getAiJobByIdempotency({
          userId,
          idempotencyKeyHash,
          prisma,
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            return { outcome: "idempotencyConflict" as const };
          }
          return existing.deletedAt
            ? { outcome: "deleted" as const }
            : { outcome: "existing" as const, job: existing };
        }
      }

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
        model,
        idempotencyKeyHash,
        requestFingerprint,
        callbackNonceHash,
        prisma,
      });
      // Read the allowance inside the reservation transaction so a concurrent
      // change in the admin console cannot let a job spend against a limit that
      // no longer applies.
      const settings = await loadAiSettings({ prisma });
      await consumeUsage({
        userId,
        amount: usageUnits,
        monthlyUsageLimit: settings.getMonthlyUsageLimit(),
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
      case "idempotencyConflict":
        return {
          ok: false as const,
          errorCode: "invalidRequestBody" as const,
          status: 409 as const,
        };
      case "deleted":
        return {
          ok: false as const,
          errorCode: "aiRequestWasDeleted" as const,
          status: 409 as const,
        };
      case "reserved":
        return {
          ok: true as const,
          outcome: "reserved" as const,
          job: result.job,
        };
      case "existing":
        return {
          ok: true as const,
          outcome: "existing" as const,
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
    if (
      idempotencyKeyHash &&
      requestFingerprint &&
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "P2002"
    ) {
      const existing = await getAiJobByIdempotency({
        userId,
        idempotencyKeyHash,
      });
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return {
            ok: false as const,
            errorCode: "invalidRequestBody" as const,
            status: 409 as const,
          };
        }
        if (existing.deletedAt) {
          return {
            ok: false as const,
            errorCode: "aiRequestWasDeleted" as const,
            status: 409 as const,
          };
        }
        return {
          ok: true as const,
          outcome: "existing" as const,
          job: existing,
        };
      }
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
    // Account deletion can cascade the reservation while provider or storage
    // work is still unwinding. With no user-owned job or ledger left, refunding
    // is already complete and this cleanup path is intentionally idempotent.
    if (!job) {
      return;
    }
    if (job.userId !== userId) {
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

export async function failFinalizingAiJobAndRefundUsage({
  userId,
  aiJobId,
  finalizationToken,
  expectedProviderJobId,
  error,
}: {
  userId: string;
  aiJobId: string;
  finalizationToken: string;
  expectedProviderJobId: string;
  error: string;
}) {
  await startRetryableTransaction(async (prisma) => {
    const subscription = await getSubscriptionByUserId({ userId, prisma });
    const usagePeriod = subscription
      ? toUsagePeriod(subscription)
      : { start: null, end: null };
    const changed = await failAiJobOwnedByFinalizer({
      jobId: aiJobId,
      finalizationToken,
      expectedProviderJobId,
      error,
      prisma,
    });
    if (!changed) return;
    await refundUsage({ userId, usagePeriod, aiJobId, prisma });
  });
}

export async function failPolledAiJobAndRefundUsage({
  userId,
  aiJobId,
  providerPollLeaseExpiresAt,
  expectedProviderJobId,
  error,
}: {
  userId: string;
  aiJobId: string;
  providerPollLeaseExpiresAt: Date;
  expectedProviderJobId: string;
  error: string;
}) {
  await startRetryableTransaction(async (prisma) => {
    const subscription = await getSubscriptionByUserId({ userId, prisma });
    const usagePeriod = subscription
      ? toUsagePeriod(subscription)
      : { start: null, end: null };
    const changed = await failAiJobOwnedByProviderPoll({
      jobId: aiJobId,
      providerPollLeaseExpiresAt,
      expectedProviderJobId,
      error,
      prisma,
    });
    if (!changed) return;
    await refundUsage({ userId, usagePeriod, aiJobId, prisma });
  });
}

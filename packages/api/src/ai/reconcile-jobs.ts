import {
  claimGatewayVideoCostSettlement,
  deferEstimatedGatewayVideoCostLookup,
  getAiJobById,
  hasFreshAiJobFinalizationLease,
  isActiveAiJobStatus,
  listActiveAiJobsForReconciliation,
  listEstimatedGatewayVideoJobsForReconciliation,
  listUnsettledGatewayVideoJobsForReconciliation,
  releaseGatewayVideoCostSettlement,
  touchActiveAiJob,
} from "@beutl/db";
import { failAiJobAndRefundUsage } from "./credits";
import {
  correctEstimatedGatewayVideoUsage,
  GATEWAY_VIDEO_COST_GRACE_MILLISECONDS,
  GATEWAY_VIDEO_COST_POLL_TIMEOUT_MILLISECONDS,
  GATEWAY_VIDEO_COST_SETTLEMENT_LEASE_MILLISECONDS,
  reconcileAiStorageCleanups,
  settleDeferredGatewayVideoUsage,
} from "./storage";
import { synchronizeAiVideoJob } from "./video-jobs";
import { AI_JOB_FAILURE_MESSAGES } from "./job-errors";
import type { ProviderCostUsd } from "./provider-cost";
import {
  DEFAULT_AI_PROVIDER_ID,
  findAiProvider,
  providerFor,
  videoProviderFor,
} from "./providers/registry";

const SCAN_DELAY_MILLISECONDS = 60 * 1000;
const ABANDONED_SYNCHRONOUS_JOB_MILLISECONDS = 30 * 60 * 1000;
// Each check can spend up to 10s on status and 5s on generation cost.
const MAX_DEFERRED_COST_JOBS_PER_SCAN = 10;
const MAX_LATE_COST_JOBS_PER_SCAN = 10;
const LATE_COST_RETRY_DELAY_MILLISECONDS = 15 * 60 * 1000;
const LATE_COST_HOURLY_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;
const LATE_COST_DAILY_AFTER_MILLISECONDS = 7 * LATE_COST_HOURLY_AFTER_MILLISECONDS;

// Keep eventual actual-cost correction possible without polling a missing
// Gateway ledger entry every 15 minutes forever. No provider retention cutoff
// is assumed: old jobs are still retried, but only once a day.
export function lateCostRetryUpdatedAt(now: Date, settledAt: Date): Date {
  const age = Math.max(0, now.getTime() - settledAt.getTime());
  const delay = age < LATE_COST_HOURLY_AFTER_MILLISECONDS
    ? LATE_COST_RETRY_DELAY_MILLISECONDS
    : age < LATE_COST_DAILY_AFTER_MILLISECONDS
      ? 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
  // The scan selects updatedAt <= now - 15 minutes. Move the timestamp
  // forward so that same predicate becomes due after the chosen delay.
  return new Date(now.getTime() + delay - LATE_COST_RETRY_DELAY_MILLISECONDS);
}

// How long a job of this provider's can still deliver something usable.
//
// A provider that is not registered cannot say, and this is reached from a
// catch block where throwing would lose the row: fall back to the default
// provider's window, which is the flat one every job used before providers
// were told apart. Never fall back to "forever" — that holds reserved units.
function maximumVideoJobAgeOf(provider: string): number {
  return (
    findAiProvider(provider) ?? providerFor(DEFAULT_AI_PROVIDER_ID)
  ).maximumVideoJobMilliseconds();
}

export type AiJobReconciliationResult = {
  inspected: number;
  succeeded: number;
  failed: number;
  pending: number;
  errors: number;
  cleanupInspected: number;
  cleanupDeleted: number;
  cleanupErrors: number;
  deferredCostInspected: number;
  deferredCostSettled: number;
  deferredCostEstimated: number;
  deferredCostPending: number;
  deferredCostErrors: number;
  lateCostInspected: number;
  lateCostCorrected: number;
  lateCostPending: number;
  lateCostErrors: number;
};

export async function reconcileAiJobs(
  now = new Date(),
): Promise<AiJobReconciliationResult> {
  const cleanup = await reconcileAiStorageCleanups(now);
  const jobs = await listActiveAiJobsForReconciliation({
    updatedBefore: new Date(now.getTime() - SCAN_DELAY_MILLISECONDS),
  });
  const result: AiJobReconciliationResult = {
    inspected: jobs.length,
    succeeded: 0,
    failed: 0,
    pending: 0,
    errors: 0,
    cleanupInspected: cleanup.inspected,
    cleanupDeleted: cleanup.deleted,
    cleanupErrors: cleanup.errors,
    deferredCostInspected: 0,
    deferredCostSettled: 0,
    deferredCostEstimated: 0,
    deferredCostPending: 0,
    deferredCostErrors: 0,
    lateCostInspected: 0,
    lateCostCorrected: 0,
    lateCostPending: 0,
    lateCostErrors: 0,
  };

  const recordFailureOutcome = async (jobId: string) => {
    const current = await getAiJobById({ jobId });
    if (current?.status === "failed") {
      result.failed++;
    } else {
      result.pending++;
    }
  };

  for (const job of jobs) {
    try {
      const age = now.getTime() - job.createdAt.getTime();
      if (job.kind !== "video") {
        if (age < ABANDONED_SYNCHRONOUS_JOB_MILLISECONDS) {
          await touchActiveAiJob({
            jobId: job.id,
            status: job.status,
          });
          result.pending++;
          continue;
        }
        await failAiJobAndRefundUsage({
          userId: job.userId,
          aiJobId: job.id,
          error: "AI operation timed out before completion",
        });
        await recordFailureOutcome(job.id);
        continue;
      }

      if (!job.providerJobId) {
        // Submission transport failures are ambiguous: the provider may have
        // accepted and charged for a job whose ID only arrives by callback.
        // Keep the reservation active for the provider's maximum job window.
        // Once that window has elapsed, no usable result can still be delivered,
        // so refund the user instead of holding reserved units forever.
        // How long that window is belongs to the provider that took the job.
        if (age < maximumVideoJobAgeOf(job.provider)) {
          await touchActiveAiJob({
            jobId: job.id,
            status: job.status,
          });
          result.pending++;
        } else {
          await failAiJobAndRefundUsage({
            userId: job.userId,
            aiJobId: job.id,
            error: "AI video submission could not be reconciled",
            expectedProviderJobId: null,
          });
          const current = await getAiJobById({ jobId: job.id });
          if (
            current?.providerJobId &&
            current.status !== "succeeded" &&
            current.status !== "failed"
          ) {
            const synchronized = await synchronizeAiVideoJob({
              job: current,
              now,
            });
            if (synchronized?.status === "succeeded") result.succeeded++;
            else if (synchronized?.status === "failed") result.failed++;
            else result.pending++;
          } else {
            await recordFailureOutcome(job.id);
          }
        }
        continue;
      }

      const synchronized = await synchronizeAiVideoJob({ job, now });
      const current = synchronized ?? await getAiJobById({ jobId: job.id });
      if (current?.status === "succeeded") {
        result.succeeded++;
      } else if (current?.status === "failed") {
        result.failed++;
      } else if (
        current &&
        hasFreshAiJobFinalizationLease(current, now)
      ) {
        result.pending++;
      } else if (age >= maximumVideoJobAgeOf(job.provider)) {
        await failAiJobAndRefundUsage({
          userId: job.userId,
          aiJobId: job.id,
          error: "AI video generation timed out",
        });
        await recordFailureOutcome(job.id);
      } else {
        await touchAiJobIfStillActive(job.id);
        result.pending++;
      }
    } catch (error) {
      const age = now.getTime() - job.createdAt.getTime();
      if (job.kind === "video" && age >= maximumVideoJobAgeOf(job.provider)) {
        try {
          const current = await getAiJobById({ jobId: job.id });
          if (
            current &&
            hasFreshAiJobFinalizationLease(current, now)
          ) {
            result.errors++;
            continue;
          }
          await failAiJobAndRefundUsage({
            userId: job.userId,
            aiJobId: job.id,
            error: AI_JOB_FAILURE_MESSAGES.videoGeneration,
          });
          await recordFailureOutcome(job.id);
          continue;
        } catch (refundError) {
          console.error("Failed to refund an expired AI video job", refundError);
        }
      }
      console.error(`Failed to reconcile AI job ${job.id}`, error);
      await touchAiJobIfStillActive(job.id).catch((touchError) => {
        console.error(`Failed to rotate AI job ${job.id}`, touchError);
      });
      result.errors++;
    }
  }

  // Publishing a completed video does not wait for the Gateway usage event.
  // The reservation remains until this pass obtains the actual charge. After
  // a bounded grace period, settle the original estimate so an unavailable
  // Gateway ledger cannot hold excess units indefinitely.
  const deferred = await listUnsettledGatewayVideoJobsForReconciliation({
    updatedBefore: new Date(now.getTime() - SCAN_DELAY_MILLISECONDS),
    limit: MAX_DEFERRED_COST_JOBS_PER_SCAN,
  });
  result.deferredCostInspected = deferred.length;
  for (const job of deferred) {
    const claimNow = new Date();
    const leaseExpiresAt = new Date(
      claimNow.getTime() + GATEWAY_VIDEO_COST_SETTLEMENT_LEASE_MILLISECONDS,
    );
    try {
      const claimed = await claimGatewayVideoCostSettlement({
        jobId: job.id,
        now: claimNow,
        leaseExpiresAt,
      });
      if (!claimed) {
        result.deferredCostPending++;
        continue;
      }
    } catch (error) {
      console.error("Gateway video cost claim failed", {
        jobId: job.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      result.deferredCostErrors++;
      continue;
    }

    try {
      const completedAt = job.resultFile?.createdAt ?? job.updatedAt;
      const graceExpired = now.getTime() - completedAt.getTime() >=
        GATEWAY_VIDEO_COST_GRACE_MILLISECONDS;
      let providerCostUsd: ProviderCostUsd | undefined;
      if (job.providerJobId && job.model) {
        try {
          const remote = await videoProviderFor("vercel-gateway").status({
            providerJobId: job.providerJobId,
            model: job.model,
            signal: AbortSignal.timeout(GATEWAY_VIDEO_COST_POLL_TIMEOUT_MILLISECONDS),
          });
          if (remote.status === "completed") providerCostUsd = remote.providerCostUsd;
        } catch (error) {
          if (!graceExpired) {
            console.warn("Gateway video cost check failed", {
              jobId: job.id,
              errorType: error instanceof Error ? error.name : typeof error,
            });
            result.deferredCostErrors++;
            continue;
          }
          console.warn(`Gateway video cost unavailable after grace period for AI job ${job.id}`);
        }
      }
      if (providerCostUsd === undefined && !graceExpired) {
        result.deferredCostPending++;
        continue;
      }
      const settled = await settleDeferredGatewayVideoUsage({
        jobId: job.id,
        userId: job.userId,
        providerCostUsd,
        leaseExpiresAt,
      });
      if (settled) {
        if (providerCostUsd === undefined) result.deferredCostEstimated++;
        else result.deferredCostSettled++;
      }
    } catch (error) {
      console.error("Gateway video cost settlement failed", {
        jobId: job.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      result.deferredCostErrors++;
    } finally {
      try {
        await releaseGatewayVideoCostSettlement({ jobId: job.id, leaseExpiresAt });
      } catch (error) {
        console.error("Gateway video cost lease release failed", {
          jobId: job.id,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        result.deferredCostErrors++;
      }
    }
  }

  // The video is usable after estimate settlement. A later Gateway usage
  // event can still replace that estimate without delaying the user's output.
  const late = await listEstimatedGatewayVideoJobsForReconciliation({
    updatedBefore: new Date(now.getTime() - LATE_COST_RETRY_DELAY_MILLISECONDS),
    limit: MAX_LATE_COST_JOBS_PER_SCAN,
  });
  result.lateCostInspected = late.length;
  for (const job of late) {
    const retryUpdatedAt = lateCostRetryUpdatedAt(now, job.usageSettledAt ?? now);
    try {
      if (!job.providerJobId || !job.model) {
        throw new Error("Estimated Gateway video is missing billing identity");
      }
      const remote = await videoProviderFor("vercel-gateway").status({
        providerJobId: job.providerJobId,
        model: job.model,
        signal: AbortSignal.timeout(GATEWAY_VIDEO_COST_POLL_TIMEOUT_MILLISECONDS),
      });
      if (remote.status === "completed" && remote.providerCostUsd !== undefined) {
        const corrected = await correctEstimatedGatewayVideoUsage({
          jobId: job.id,
          userId: job.userId,
          providerCostUsd: remote.providerCostUsd,
        });
        if (corrected) result.lateCostCorrected++;
        else result.lateCostPending++;
      } else {
        await deferEstimatedGatewayVideoCostLookup({ jobId: job.id, updatedAt: retryUpdatedAt });
        result.lateCostPending++;
      }
    } catch (error) {
      await deferEstimatedGatewayVideoCostLookup({ jobId: job.id, updatedAt: retryUpdatedAt })
        .catch(() => undefined);
      console.warn("Gateway late video cost check failed", {
        jobId: job.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      result.lateCostErrors++;
    }
  }

  return result;
}

async function touchAiJobIfStillActive(jobId: string): Promise<void> {
  const current = await getAiJobById({ jobId });
  if (current && isActiveAiJobStatus(current.status)) {
    await touchActiveAiJob({
      jobId,
      status: current.status,
    });
  }
}

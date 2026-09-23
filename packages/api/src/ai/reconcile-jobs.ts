import {
  getAiJobById,
  hasFreshAiJobFinalizationLease,
  isActiveAiJobStatus,
  listActiveAiJobsForReconciliation,
  listUnsettledGatewayVideoJobsForReconciliation,
  touchActiveAiJob,
} from "@beutl/db";
import { failAiJobAndRefundUsage } from "./credits";
import { reconcileAiStorageCleanups, settleDeferredGatewayVideoUsage } from "./storage";
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
const GATEWAY_VIDEO_COST_GRACE_MILLISECONDS = 15 * 60 * 1000;
const GATEWAY_VIDEO_COST_POLL_TIMEOUT_MILLISECONDS = 10 * 1000;
// Each check can spend up to 10s on status and 5s on generation cost.
const MAX_DEFERRED_COST_JOBS_PER_SCAN = 10;

// How long a job of this provider's can still deliver something usable.
//
// A provider that is not registered cannot say, and this is reached from a
// catch block where throwing would lose the row: fall back to the default
// provider's window, which is the flat one every job used before providers
// were told apart. Never fall back to "forever" — that pins the user's slot.
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
        // so refund the user instead of pinning their one-video slot forever.
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
    try {
      const settled = await settleDeferredGatewayVideoUsage({
        jobId: job.id,
        userId: job.userId,
        providerCostUsd,
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

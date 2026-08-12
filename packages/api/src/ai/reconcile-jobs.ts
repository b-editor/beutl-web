import {
  getAiJobById,
  hasFreshAiJobFinalizationLease,
  listActiveAiJobsForReconciliation,
  touchActiveAiJob,
} from "@beutl/db";
import { failAiJobAndRefundUsage } from "./credits";
import { reconcileAiStorageCleanups } from "./storage";
import { synchronizeAiVideoJob } from "./video-jobs";
import { AI_JOB_FAILURE_MESSAGES } from "./job-errors";

const SCAN_DELAY_MILLISECONDS = 60 * 1000;
const ABANDONED_SYNCHRONOUS_JOB_MILLISECONDS = 30 * 60 * 1000;
const MAXIMUM_VIDEO_JOB_MILLISECONDS = 6 * 60 * 60 * 1000;

export type AiJobReconciliationResult = {
  inspected: number;
  succeeded: number;
  failed: number;
  pending: number;
  errors: number;
  cleanupInspected: number;
  cleanupDeleted: number;
  cleanupErrors: number;
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
        // Submission transport failures are ambiguous: OpenRouter may have
        // accepted and charged for a job whose ID only arrives by callback.
        // Keep the reservation active for the provider's maximum job window.
        // Once that window has elapsed, no usable result can still be delivered,
        // so refund the user instead of pinning their one-video slot forever.
        if (age < MAXIMUM_VIDEO_JOB_MILLISECONDS) {
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
      } else if (age >= MAXIMUM_VIDEO_JOB_MILLISECONDS) {
        await failAiJobAndRefundUsage({
          userId: job.userId,
          aiJobId: job.id,
          error: "AI video generation timed out",
        });
        await recordFailureOutcome(job.id);
      } else {
        result.pending++;
      }
    } catch (error) {
      const age = now.getTime() - job.createdAt.getTime();
      if (job.kind === "video" && age >= MAXIMUM_VIDEO_JOB_MILLISECONDS) {
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
      await touchActiveAiJob({
        jobId: job.id,
        status: job.status,
      }).catch((touchError) => {
        console.error(`Failed to rotate AI job ${job.id}`, touchError);
      });
      result.errors++;
    }
  }

  return result;
}

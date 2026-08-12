import {
  claimAiJobForProviderPoll,
  claimAiJobForFinalization,
  getAiJobById,
  hasFreshAiJobFinalizationLease,
  renewAiJobFinalizationLease,
} from "@beutl/db";
import { failAiJobAndRefundUsage } from "./credits";
import {
  AiProviderError,
  downloadVideoContent,
  getVideoJob,
} from "./openrouter";
import {
  AiOutputCommitConflictError,
  saveAiVideo,
} from "./storage";
import { AI_JOB_FAILURE_MESSAGES } from "./job-errors";

const FINALIZATION_LEASE_MILLISECONDS = 10 * 60 * 1000;
const PROVIDER_POLL_LEASE_MILLISECONDS = 10 * 1000;

type AiVideoJobRecord = {
  id: string;
  userId: string;
  providerJobId: string | null;
  status: string;
  resultFileId: string | null;
  usageUnits: number;
  error: string | null;
  providerPollLeaseExpiresAt: Date | null;
  finalizationToken: string | null;
  finalizationLeaseExpiresAt: Date | null;
  updatedAt: Date;
};

export async function synchronizeAiVideoJob({
  job,
  now = new Date(),
}: {
  job: AiVideoJobRecord;
  now?: Date;
}) {
  if (job.status === "succeeded" || job.status === "failed") {
    return job;
  }

  const pollNow = new Date(Math.max(Date.now(), now.getTime()));
  if (hasFreshAiJobFinalizationLease(job, pollNow)) {
    return job;
  }

  if (!job.providerJobId) {
    throw new AiProviderError("AI video job has no provider job ID");
  }

  const pollClaim = await claimAiJobForProviderPoll({
    jobId: job.id,
    now: pollNow,
    leaseExpiresAt: new Date(
      pollNow.getTime() + PROVIDER_POLL_LEASE_MILLISECONDS,
    ),
  });
  if (!pollClaim.claimed || !pollClaim.job) {
    return pollClaim.job;
  }
  if (!pollClaim.job.providerJobId) {
    throw new AiProviderError("AI video job has no provider job ID");
  }

  const providerJob = await getVideoJob(pollClaim.job.providerJobId);
  if (
    providerJob.status === "failed" ||
    providerJob.status === "cancelled" ||
    providerJob.status === "expired"
  ) {
    await failAiJobAndRefundUsage({
      userId: job.userId,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.videoGeneration,
    });
    return await getAiJobById({ jobId: job.id });
  }

  if (providerJob.status !== "completed") {
    return await getAiJobById({ jobId: job.id });
  }

  const leaseNow = new Date(Math.max(Date.now(), pollNow.getTime()));
  const claim = await claimAiJobForFinalization({
    jobId: job.id,
    now: leaseNow,
    leaseExpiresAt: new Date(
      leaseNow.getTime() + FINALIZATION_LEASE_MILLISECONDS,
    ),
  });
  if (!claim.claimed || !claim.job || !claim.finalizationToken) {
    return claim.job;
  }

  const { bytes, mimeType, extension } = await downloadVideoContent(
    pollClaim.job.providerJobId,
  );
  const renewalBase = Math.max(Date.now(), leaseNow.getTime());
  const renewed = await renewAiJobFinalizationLease({
    jobId: job.id,
    finalizationToken: claim.finalizationToken,
    leaseExpiresAt: new Date(
      renewalBase + FINALIZATION_LEASE_MILLISECONDS,
    ),
  });
  if (!renewed) {
    return await getAiJobById({ jobId: job.id });
  }

  try {
    await saveAiVideo({
      jobId: job.id,
      finalizationToken: claim.finalizationToken,
      userId: job.userId,
      bytes,
      mimeType,
      filename: `ai-video-${job.id}.${extension}`,
    });
  } catch (error) {
    if (error instanceof AiOutputCommitConflictError) {
      return await getAiJobById({ jobId: job.id });
    }
    throw error;
  }
  return await getAiJobById({ jobId: job.id });
}

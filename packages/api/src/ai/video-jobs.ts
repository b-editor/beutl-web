import {
  claimAiJobForProviderPoll,
  claimAiJobForFinalization,
  getAiJobById,
  hasFreshAiJobFinalizationLease,
  releaseAiJobProviderPoll,
  renewAiJobFinalizationLease,
} from "@beutl/db";
import {
  failFinalizingAiJobAndRefundUsage,
  failPolledAiJobAndRefundUsage,
} from "./credits";
import {
  AiProviderError,
  InvalidAiProviderOutputError,
  downloadVideoContent,
  getOpenRouterRequestTimeoutMilliseconds,
  getVideoJob,
} from "./openrouter";
import {
  AiOutputCommitConflictError,
  saveAiVideo,
} from "./storage";
import { AI_JOB_FAILURE_MESSAGES } from "./job-errors";

const FINALIZATION_LEASE_MILLISECONDS = 10 * 60 * 1000;
export const PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS = 30 * 1000;

export function getProviderPollLeaseMilliseconds(): number {
  const timeout = getOpenRouterRequestTimeoutMilliseconds();
  if (timeout > Number.MAX_SAFE_INTEGER - PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS) {
    throw new AiProviderError(
      "OPENROUTER_REQUEST_TIMEOUT_MS is too large for a safe provider poll lease",
    );
  }
  return timeout + PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS;
}

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

  const pollLeaseExpiresAt = new Date(
    pollNow.getTime() + getProviderPollLeaseMilliseconds(),
  );
  const pollClaim = await claimAiJobForProviderPoll({
    jobId: job.id,
    now: pollNow,
    leaseExpiresAt: pollLeaseExpiresAt,
  });
  if (!pollClaim.claimed || !pollClaim.job) {
    return pollClaim.job;
  }
  if (!pollClaim.job.providerJobId) {
    throw new AiProviderError("AI video job has no provider job ID");
  }

  let providerJob: Awaited<ReturnType<typeof getVideoJob>>;
  try {
    providerJob = await getVideoJob(pollClaim.job.providerJobId);
  } catch (error) {
    await releaseAiJobProviderPoll({
      jobId: job.id,
      leaseExpiresAt: pollLeaseExpiresAt,
    });
    throw error;
  }
  if (
    providerJob.status === "failed" ||
    providerJob.status === "cancelled" ||
    providerJob.status === "expired"
  ) {
    await failPolledAiJobAndRefundUsage({
      userId: job.userId,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.videoGeneration,
      providerPollLeaseExpiresAt: pollLeaseExpiresAt,
      expectedProviderJobId: pollClaim.job.providerJobId,
    });
    return await getAiJobById({ jobId: job.id });
  }

  if (providerJob.status !== "completed") {
    await releaseAiJobProviderPoll({
      jobId: job.id,
      leaseExpiresAt: pollLeaseExpiresAt,
    });
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

  let content: Awaited<ReturnType<typeof downloadVideoContent>>;
  try {
    content = await downloadVideoContent(pollClaim.job.providerJobId);
  } catch (error) {
    if (error instanceof InvalidAiProviderOutputError) {
      await failFinalizingAiJobAndRefundUsage({
        userId: job.userId,
        aiJobId: job.id,
        finalizationToken: claim.finalizationToken,
        error: AI_JOB_FAILURE_MESSAGES.videoGeneration,
        expectedProviderJobId: pollClaim.job.providerJobId,
      });
      return await getAiJobById({ jobId: job.id });
    }
    throw error;
  }
  const { bytes, mimeType, extension } = content;
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

import {
  attachProviderJobIdToQueuedAiJob,
  claimAiJobForProviderPoll,
  claimAiJobForFinalization,
  enqueueAiRemoteJobCleanup,
  getAiJobById,
  getAiJobByProviderJobId,
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
  createVideoJob,
  downloadVideoContent,
  getOpenRouterRequestTimeoutMilliseconds,
  getVideoJob,
  isDefiniteVideoSubmissionFailure,
  type VideoFrameImage,
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

// The local job lost its link to a submission the provider accepted.
export class DetachedRemoteVideoJobError extends AiProviderError {}

// The provider returned a job ID another local job already owns.
export class ProviderVideoJobOwnershipConflictError extends AiProviderError {}

function attachmentVerificationError(...causes: unknown[]): AiProviderError {
  return new AiProviderError("AI video job attachment could not be verified", {
    cause: new AggregateError(causes),
    execution: "unknown",
  });
}

// Submit a video to the provider and bind the returned job ID to the local job.
//
// Every entry point that starts a video goes through here. The sequence has one
// hard requirement — once OpenRouter returns an ID, that ID is either stored on
// the local job or handed to the cleanup outbox, never dropped — and a copy of
// it that omits a branch silently leaks a submission the user has paid for.
export async function createAndAttachVideoJob({
  jobId,
  prompt,
  durationSeconds,
  resolution,
  frameImages,
  callbackUrl,
  callbackNonceHash,
  model,
  signal,
}: {
  jobId: string;
  prompt: string;
  durationSeconds: number;
  resolution: "720p" | "1080p";
  frameImages?: VideoFrameImage[];
  callbackUrl: string;
  callbackNonceHash: string;
  model: string;
  signal?: AbortSignal;
}) {
  // A transport timeout can hide a provider-side acceptance before any job ID
  // reaches us. Once OpenRouter returns an ID, however, it is always persisted
  // either on the local job or in the User-independent cleanup outbox.
  const providerJob = await createVideoJob({
    prompt,
    durationSeconds,
    resolution,
    callbackUrl,
    ...(frameImages ? { frameImages } : {}),
    model,
    signal,
  });
  let attachment: Awaited<ReturnType<typeof attachProviderJobIdToQueuedAiJob>>;
  try {
    attachment = await attachProviderJobIdToQueuedAiJob({
      jobId,
      kind: "video",
      provider: "openrouter",
      providerJobId: providerJob.id,
      expectedCallbackNonceHash: callbackNonceHash,
    });
  } catch (cause) {
    let localJob: Awaited<ReturnType<typeof getAiJobById>>;
    let providerOwner: Awaited<ReturnType<typeof getAiJobByProviderJobId>>;
    try {
      [localJob, providerOwner] = await Promise.all([
        getAiJobById({ jobId }),
        getAiJobByProviderJobId({
          provider: "openrouter",
          providerJobId: providerJob.id,
        }),
      ]);
    } catch (verificationCause) {
      throw attachmentVerificationError(cause, verificationCause);
    }
    if (
      localJob?.providerJobId === providerJob.id &&
      providerOwner?.id === jobId
    ) {
      return providerJob;
    }
    if (providerOwner && providerOwner.id !== jobId) {
      throw new ProviderVideoJobOwnershipConflictError(
        "OpenRouter returned a provider job ID already owned by another job",
        { cause, execution: "unknown" },
      );
    }
    await enqueueAiRemoteJobCleanup({
      provider: "openrouter",
      providerJobId: providerJob.id,
    });
    throw new DetachedRemoteVideoJobError(
      "AI video job attachment could not be confirmed",
      { cause, execution: "unknown" },
    );
  }
  if (attachment.outcome === "notFound" || attachment.outcome === "conflict") {
    let providerOwner: Awaited<ReturnType<typeof getAiJobByProviderJobId>>;
    try {
      providerOwner = await getAiJobByProviderJobId({
        provider: "openrouter",
        providerJobId: providerJob.id,
      });
    } catch (cause) {
      throw attachmentVerificationError(cause);
    }
    if (providerOwner && providerOwner.id !== jobId) {
      throw new ProviderVideoJobOwnershipConflictError(
        "OpenRouter returned a provider job ID already owned by another job",
        { execution: "unknown" },
      );
    }
    if (!providerOwner) {
      await enqueueAiRemoteJobCleanup({
        provider: "openrouter",
        providerJobId: providerJob.id,
      });
    }
    throw new DetachedRemoteVideoJobError(
      "AI video job was deleted after remote submission",
      { execution: "unknown" },
    );
  }
  return providerJob;
}

// What to do with the reservation when a submission throws.
//
// "refund" means the provider is certainly not working on anything we are
// charging for — either it never received the request, or it did and the
// submission is now disowned. `detachProviderJob` says which: a disowned
// submission must clear the provider ID off the job as it fails, so the refund
// is not mistaken for one belonging to a live remote job.
//
// "keepQueued" means the outcome is genuinely unknown and the provider may yet
// call back, so the job stays queued and paid for.
export type VideoSubmissionFailureHandling =
  | { action: "refund"; detachProviderJob: boolean }
  | { action: "keepQueued" }
  | { action: "rethrow" };

export function classifyVideoSubmissionFailure(
  error: unknown,
): VideoSubmissionFailureHandling {
  if (
    error instanceof DetachedRemoteVideoJobError ||
    error instanceof ProviderVideoJobOwnershipConflictError
  ) {
    return { action: "refund", detachProviderJob: true };
  }
  if (isDefiniteVideoSubmissionFailure(error)) {
    return { action: "refund", detachProviderJob: false };
  }
  if (error instanceof AiProviderError) {
    return { action: "keepQueued" };
  }
  return { action: "rethrow" };
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

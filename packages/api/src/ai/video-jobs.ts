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
  AiVideoSubmissionError,
  InvalidAiProviderOutputError,
  isDefiniteVideoSubmissionFailure,
  type VideoFrameImage,
} from "./openrouter";
import {
  DEFAULT_AI_PROVIDER_ID,
  videoProviderFor,
} from "./providers/registry";
import type {
  AiVideoContent,
  AiVideoJobInfo,
  VideoFrameImage as ProviderVideoFrameImage,
  VideoInputReference,
} from "./providers/types";
import {
  publishVideoInputMedia,
} from "./video-input-media";
import type { AiVideoAspectRatio, AiVideoResolution } from "@beutl/core";
import {
  AiOutputCommitConflictError,
  saveAiVideo,
} from "./storage";
import { AI_JOB_FAILURE_MESSAGES } from "./job-errors";

const FINALIZATION_LEASE_MILLISECONDS = 10 * 60 * 1000;

// Re-exported from the OpenRouter adapter, which is where the lease arithmetic
// moved when it stopped being the only provider's.
export { PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS } from "./providers/openrouter";

/** The default provider's poll lease. A job's own provider decides its lease. */
export function getProviderPollLeaseMilliseconds(): number {
  return videoProviderFor(DEFAULT_AI_PROVIDER_ID).pollLeaseMilliseconds();
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

// Move the pictures a request carries out of the submission and behind a URL.
//
// Only for a provider that cannot read them out of the submission. The data
// URLs the entry points build are decoded back to bytes here rather than at
// each entry point, because this is the one place every submission passes
// through and a copy that forgot would send a request the provider refuses
// after the usage is reserved.
function decodeDataUrl(url: string): { bytes: ArrayBuffer; mimeType: string } {
  // [\s\S] rather than the s flag: the admin app compiles this file against an
  // older target where that flag is unavailable.
  const match = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(url);
  if (!match) {
    throw new AiVideoSubmissionError(
      "An AI video picture could not be read",
      { outcome: "definite_failure" },
    );
  }
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { bytes: bytes.buffer, mimeType: match[1] };
}

async function hostVideoInputMedia({
  jobId,
  callbackNonce,
  frameImages,
  inputReferences,
  mediaOrigin,
}: {
  jobId: string;
  callbackNonce: string;
  frameImages: VideoFrameImage[] | undefined;
  inputReferences: VideoInputReference[] | undefined;
  mediaOrigin: string | undefined;
}): Promise<{
  frameImages?: ProviderVideoFrameImage[];
  inputReferences?: VideoInputReference[];
}> {
  const hasMedia =
    (frameImages?.length ?? 0) > 0 || (inputReferences?.length ?? 0) > 0;
  if (!hasMedia) return {};
  if (!mediaOrigin) {
    // Sending the request without the pictures would produce a video of
    // something else and charge for it.
    throw new AiVideoSubmissionError(
      "This deployment cannot serve AI video pictures to the provider",
      { outcome: "definite_failure" },
    );
  }

  const hosted: {
    frameImages?: ProviderVideoFrameImage[];
    inputReferences?: VideoInputReference[];
  } = {};
  if (frameImages && frameImages.length > 0) {
    hosted.frameImages = await Promise.all(
      frameImages.map(async (frame) => {
        const { bytes, mimeType } = decodeDataUrl(frame.image_url.url);
        const { url } = await publishVideoInputMedia({
          jobId,
          nonce: callbackNonce,
          bytes,
          mimeType,
          origin: mediaOrigin,
        });
        return { ...frame, image_url: { url } };
      }),
    );
  }
  if (inputReferences && inputReferences.length > 0) {
    hosted.inputReferences = await Promise.all(
      inputReferences.map(async (reference) => {
        const { bytes, mimeType } = decodeDataUrl(reference.image_url.url);
        const { url } = await publishVideoInputMedia({
          jobId,
          nonce: callbackNonce,
          bytes,
          mimeType,
          origin: mediaOrigin,
        });
        return { ...reference, image_url: { url }, media_type: mimeType };
      }),
    );
  }
  return hosted;
}

// Submit a video to the provider and bind the returned job ID to the local job.
//
// Every entry point that starts a video goes through here. The sequence has one
// hard requirement — once the provider returns an ID, that ID is either stored
// on the local job or handed to the cleanup outbox, never dropped — and a copy
// of it that omits a branch silently leaks a submission the user has paid for.
export async function createAndAttachVideoJob({
  jobId,
  prompt,
  durationSeconds,
  resolution,
  aspectRatio,
  generateAudio,
  seed,
  frameImages,
  inputReferences,
  mode,
  sourceVideo,
  motionOrientation,
  motionQuality,
  callbackUrl,
  callbackNonce,
  callbackNonceHash,
  model,
  provider = DEFAULT_AI_PROVIDER_ID,
  mediaOrigin,
  signal,
}: {
  jobId: string;
  prompt: string;
  durationSeconds: number;
  resolution: AiVideoResolution;
  aspectRatio?: AiVideoAspectRatio;
  generateAudio?: boolean;
  seed?: number;
  frameImages?: VideoFrameImage[];
  /** Reference pictures for reference-to-video. Never sent with frames. */
  inputReferences?: VideoInputReference[];
  /**
   * Absent for an ordinary generation. Editing modes use an uploaded video,
   * which is served to the provider rather than sent inline.
   */
  mode?: "edit" | "extend" | "motion";
  /**
   * A video the caller uploaded. The container is validated before
   * anything is reserved, which is also where its length comes from — so what
   * arrives here is only served.
   */
  sourceVideo?: { bytes: ArrayBuffer; mimeType: string };
  motionOrientation?: "image" | "video";
  motionQuality?: "standard" | "pro";
  // Absent when the deployment has no HTTPS origin for the provider to call
  // back on, which is the case for a local server. The job is then finished by
  // the poll path instead of the callback.
  callbackUrl?: string;
  /** The job nonce carried by provider-only media URLs; only its hash is stored. */
  callbackNonce: string;
  callbackNonceHash: string;
  model: string;
  /** Defaults to the provider every catalog row carried before the column existed. */
  provider?: string;
  /**
   * The public HTTPS origin pictures can be served from, for a provider that
   * cannot read them out of the submission. Absent on a deployment that has
   * none — the same condition that withholds a callback URL — and a request
   * carrying pictures for such a provider is then refused rather than sent
   * without them.
   */
  mediaOrigin?: string;
  signal?: AbortSignal;
}) {
  const videoProvider = videoProviderFor(provider);
  let sourceVideoUrl: string | undefined;
  let media: Awaited<ReturnType<typeof hostVideoInputMedia>>;
  try {
    if (mode !== undefined) {
      if (!sourceVideo) {
        throw new AiVideoSubmissionError(
          `A ${mode} request needs a source video`,
          { outcome: "definite_failure" },
        );
      }
      if (!mediaOrigin) {
        throw new AiVideoSubmissionError(
          "This deployment cannot serve AI video pictures to the provider",
          { outcome: "definite_failure" },
        );
      }
      const { url } = await publishVideoInputMedia({
        jobId,
        nonce: callbackNonce,
        bytes: sourceVideo.bytes,
        mimeType: sourceVideo.mimeType,
        origin: mediaOrigin,
      });
      sourceVideoUrl = url;
    }
    media = videoProvider.requiresHostedMedia
      ? await hostVideoInputMedia({
          jobId,
          callbackNonce,
          frameImages,
          inputReferences,
          mediaOrigin,
        })
      : { frameImages, inputReferences };
  } catch (cause) {
    // No provider request has started, so even an ambiguous storage write
    // cannot have charged for a generation. Its cleanup row remains queued.
    throw new AiVideoSubmissionError("Failed to stage AI video input media", {
      outcome: "definite_failure",
      cause,
    });
  }
  // A transport timeout can hide a provider-side acceptance before any job ID
  // reaches us. Once the provider returns an ID, however, it is always persisted
  // either on the local job or in the User-independent cleanup outbox.
  const providerJob = await videoProvider.start({
    prompt,
    durationSeconds,
    resolution,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(generateAudio === undefined ? {} : { generateAudio }),
    ...(seed === undefined ? {} : { seed }),
    ...(callbackUrl === undefined ? {} : { callbackUrl }),
    ...(media.frameImages ? { frameImages: media.frameImages } : {}),
    ...(media.inputReferences
      ? { inputReferences: media.inputReferences }
      : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(sourceVideoUrl === undefined ? {} : { sourceVideoUrl }),
    ...(motionOrientation === undefined ? {} : { motionOrientation }),
    ...(motionQuality === undefined ? {} : { motionQuality }),
    model,
    // The local job id: a provider that deduplicates on it charges once even if
    // this job is submitted again.
    idempotencyKey: jobId,
    signal,
  });
  let attachment: Awaited<ReturnType<typeof attachProviderJobIdToQueuedAiJob>>;
  try {
    attachment = await attachProviderJobIdToQueuedAiJob({
      jobId,
      kind: "video",
      provider,
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
          provider,
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
        "The provider returned a job ID already owned by another job",
        { cause, execution: "unknown" },
      );
    }
    await enqueueAiRemoteJobCleanup({
      provider,
      providerJobId: providerJob.id,
      model,
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
        provider,
        providerJobId: providerJob.id,
      });
    } catch (cause) {
      throw attachmentVerificationError(cause);
    }
    if (providerOwner && providerOwner.id !== jobId) {
      throw new ProviderVideoJobOwnershipConflictError(
        "The provider returned a job ID already owned by another job",
        { execution: "unknown" },
      );
    }
    if (!providerOwner) {
      await enqueueAiRemoteJobCleanup({
        provider,
        providerJobId: providerJob.id,
        model,
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
  /**
   * Who accepted the job, and on which model. Optional because a caller may
   * hand over a record assembled before these columns were read; both fall
   * back to what every row written before them carries.
   */
  provider?: string;
  model?: string | null;
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

  const provider = videoProviderFor(job.provider ?? DEFAULT_AI_PROVIDER_ID);
  const pollLeaseExpiresAt = new Date(
    pollNow.getTime() + provider.pollLeaseMilliseconds(),
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

  // The Gateway addresses a job by model as well as by id; OpenRouter ignores
  // the model. Both read it from the same place.
  const providerJobRef = {
    providerJobId: pollClaim.job.providerJobId,
    model: job.model ?? null,
  };
  let providerJob: AiVideoJobInfo;
  try {
    providerJob = await provider.status(providerJobRef);
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

  let content: AiVideoContent;
  try {
    content = await provider.download(providerJob, providerJobRef);
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
      providerCostUsd: providerJob.providerCostUsd,
    });
  } catch (error) {
    if (error instanceof AiOutputCommitConflictError) {
      return await getAiJobById({ jobId: job.id });
    }
    throw error;
  }
  return await getAiJobById({ jobId: job.id });
}

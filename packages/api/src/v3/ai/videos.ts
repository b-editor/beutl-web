import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  findReplayableAiJob,
  aiJobStateForIdempotencyKey,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import {
  isVideoInputMediaId,
  readVideoInputMedia,
} from "../../ai/video-input-media";
import {
  isVideoModelUsable,
  loadAiVideoModelCapabilities,
  unsupportedVideoRequestReason,
  videoCapabilityOf,
} from "../../ai/video-model-capabilities";
import { getEntitlements } from "../../ai/entitlements";
import {
  fileExceedsUploadLimit,
  isUploadLimitExceeded,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  parseBodyWithUploadLimit,
  parseJsonWithBodyLimit,
} from "../../ai/upload-limits";
import {
  AiProviderError,
  AiVideoSubmissionError,
  verifyOpenRouterWebhookSignature,
  type VideoFrameImage,
} from "../../ai/openrouter";
import type { VideoInputReference } from "../../ai/providers/types";
import {
  classifyVideoSubmissionFailure,
  createAndAttachVideoJob,
  synchronizeAiVideoJob,
} from "../../ai/video-jobs";
import {
  aiApiMultipartBodyLimit,
  AI_MAX_VIDEO_INPUT_AUDIO_REFERENCES,
  AI_MAX_VIDEO_INPUT_REFERENCES,
  AI_MAX_VIDEO_INPUT_VIDEO_REFERENCES,
  MAX_AI_VIDEO_INPUT_AUDIO_BYTES,
  MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES,
  MAX_AI_VIDEO_INPUT_REFERENCES_TOTAL_BYTES,
  MAX_AI_VIDEO_REFERENCES_TOTAL_BYTES,
} from "@beutl/core";
import { inspectGeneratedVideo } from "../../ai/video-validation";
import {
  validateAiInputImage,
  type AiInputImageMimeType,
} from "../../ai/input-image-validation";
import {
  attachProviderJobIdToQueuedAiJob,
  getAiJobById,
  getAiJobByProviderJobId,
} from "@beutl/db";
import { AI_JOB_FAILURE_MESSAGES } from "../../ai/job-errors";
import {
  callbackNonceMatches,
  createCallbackNonce,
  getAiIdempotencyKeyHash,
  getAiRequestIdentity,
  sha256Hex,
} from "../../ai/request-integrity";
import {
  isTerminalAiJobStatus,
  publicAiJobPayload,
} from "../../ai/job-response";
import {
  AI_MAX_SEED,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_RESOLUTIONS,
  isAiVideoDurationSeconds,
  MAX_MODEL_ID_LENGTH,
} from "@beutl/core";

// generateAudio defaults to true so an existing client keeps the behaviour it
// has today, and so the figure the admin console estimates — which has always
// assumed audio — keeps matching what is actually requested.
const createSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z
    .number()
    .refine(isAiVideoDurationSeconds),
  resolution: z.enum(AI_VIDEO_RESOLUTIONS).default("720p"),
  aspectRatio: z.enum(AI_VIDEO_ASPECT_RATIOS).default("16:9"),
  generateAudio: z.boolean().default(true),
  seed: z.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
  model: z.string().min(1).max(MAX_MODEL_ID_LENGTH).optional(),
}).strict();

const createFramesSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  // Multipart carries strings, so the length arrives as one.
  durationSeconds: z.coerce.number().refine(isAiVideoDurationSeconds),
  resolution: z.enum(AI_VIDEO_RESOLUTIONS).default("720p"),
  aspectRatio: z.enum(AI_VIDEO_ASPECT_RATIOS).default("16:9"),
  // Multipart carries strings, so the flag arrives as one.
  generateAudio: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  seed: z.coerce.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
  model: z.string().min(1).max(MAX_MODEL_ID_LENGTH).optional(),
}).strict();

/**
 * Whether the source clip is one the chosen model will take.
 *
 * The allowances are published per model and are already reported to clients;
 * checking them here as well is what keeps a clip outside the range from being
 * reserved, charged and only then refused by the provider. Bytes are known
 * only for an upload — a named job's are not read until the job is submitted —
 * so that half is checked when it is available.
 */
function sourceVideoOutsideModelRange(
  capabilities:
    | {
        maxSourceVideoBytes: number;
        minSourceVideoSeconds: number | null;
        maxSourceVideoSeconds: number | null;
      }
    | undefined,
  source: { bytes?: number; durationSeconds: number },
): boolean {
  if (!capabilities) return false;
  if (
    source.bytes !== undefined &&
    source.bytes > capabilities.maxSourceVideoBytes
  ) {
    return true;
  }
  if (
    capabilities.minSourceVideoSeconds !== null &&
    source.durationSeconds < capabilities.minSourceVideoSeconds
  ) {
    return true;
  }
  return (
    capabilities.maxSourceVideoSeconds !== null &&
    source.durationSeconds > capabilities.maxSourceVideoSeconds
  );
}

type AiJobRow = NonNullable<Awaited<ReturnType<typeof getAiJobById>>>;

/**
 * Bind a terminal callback's provider job id to the local job, or refuse it.
 *
 * A job whose start response never arrived is left queued with no provider id
 * on purpose — the submission may have been accepted, so it is not refunded.
 * The callback is then the only thing that carries the id the provider went on
 * to use, and turning it away would strand a result the account has paid for
 * until reconciliation gives up hours later.
 *
 * Attaching is a compare-and-set against the queued state and the callback
 * nonce, and the provider-id uniqueness constraint stops a delivery taking
 * ownership from another job. Both callbacks go through here so neither drifts
 * from the other on a path this subtle.
 */
async function claimCallbackProviderJob({
  jobId,
  job,
  provider,
  providerJobId,
}: {
  jobId: string;
  job: AiJobRow;
  provider: string;
  providerJobId: string;
}): Promise<{ ok: true; job: AiJobRow } | { ok: false; status: 409 | 500 }> {
  if (job.providerJobId !== null) {
    return job.providerJobId === providerJobId
      ? { ok: true, job }
      : { ok: false, status: 409 };
  }

  try {
    const attachment = await attachProviderJobIdToQueuedAiJob({
      jobId,
      kind: "video",
      provider,
      providerJobId,
      expectedCallbackNonceHash: job.callbackNonceHash!,
    });
    if (attachment.outcome === "notFound" || attachment.outcome === "conflict") {
      return { ok: false, status: 409 };
    }
    const attachedJob = await getAiJobById({ jobId });
    if (!attachedJob || attachedJob.providerJobId !== providerJobId) {
      return { ok: false, status: 409 };
    }
    return { ok: true, job: attachedJob };
  } catch (attachmentError) {
    // The write may still have landed. Read both sides before deciding, so a
    // lost response does not refuse a job this delivery does own.
    let latestJob: Awaited<ReturnType<typeof getAiJobById>>;
    let providerOwner: Awaited<ReturnType<typeof getAiJobByProviderJobId>>;
    try {
      [latestJob, providerOwner] = await Promise.all([
        getAiJobById({ jobId }),
        getAiJobByProviderJobId({ provider, providerJobId }),
      ]);
    } catch (verificationError) {
      console.error(
        `Failed to verify ${provider} callback attachment for AI job ${jobId}`,
        new AggregateError([attachmentError, verificationError]),
      );
      return { ok: false, status: 500 };
    }
    if (
      (providerOwner && providerOwner.id !== jobId) ||
      (latestJob?.providerJobId !== null &&
        latestJob?.providerJobId !== providerJobId)
    ) {
      return { ok: false, status: 409 };
    }
    if (!latestJob || latestJob.providerJobId !== providerJobId ||
        providerOwner?.id !== jobId) {
      console.error(
        `Failed to attach ${provider} callback provider job to AI job ${jobId}`,
        attachmentError,
      );
      return { ok: false, status: 500 };
    }
    return { ok: true, job: latestJob };
  }
}

/** What one reference is, decided by what its part declares. */
type VideoReferenceKind = "image" | "video" | "audio";

// Only the types this service can check. A picture is decoded, a clip is
// parsed, and a sound is taken on its declared type — there is no sound parser
// here, so the allowlist is the check, and it is deliberately narrow.
const VIDEO_REFERENCE_AUDIO_TYPES: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
]);

function videoReferenceKindOf(declared: string): VideoReferenceKind | null {
  const mediaType = declared.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "video/mp4" || mediaType === "video/webm") return "video";
  if (VIDEO_REFERENCE_AUDIO_TYPES.has(mediaType)) return "audio";
  return null;
}

// The same request with the source sent inline instead of named. Multipart, so
// every scalar arrives as a string and the length has to be coerced.
const uploadedSourceVideoSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z.coerce.number().refine(isAiVideoDurationSeconds).optional(),
  model: z.string().min(1).max(MAX_MODEL_ID_LENGTH).optional(),
}).strict();

/**
 * The size of the largest file in a set, or 0 for an empty one.
 *
 * A model publishes a limit per reference rather than for the set, so the
 * largest member is what decides whether the set is acceptable.
 */
function largestBytesOf(files: readonly File[]): number {
  let largest = 0;
  for (const file of files) {
    if (file.size > largest) largest = file.size;
  }
  return largest;
}

/** Video editing accepts uploaded media in multipart requests. */
function isMultipartRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return contentType.split(";", 1)[0]!.trim().toLowerCase() ===
    "multipart/form-data";
}

// Motion control uploads both the character picture and its source video.
const motionSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z.coerce.number().refine(isAiVideoDurationSeconds),
  // Whether the result follows the character picture's shape or the reference
  // video's. The provider allows a longer result for the latter.
  orientation: z.enum(["image", "video"]).default("video"),
  quality: z.enum(["standard", "pro"]).default("standard"),
  model: z.string().min(1).max(MAX_MODEL_ID_LENGTH).optional(),
}).strict();

const supportedFrameImageTypes = new Set<AiInputImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_OPENROUTER_WEBHOOK_BODY_BYTES = 64 * 1024;

const openRouterVideoWebhookSchema = z.object({
  type: z.enum([
    "video.generation.completed",
    "video.generation.failed",
    "video.generation.cancelled",
    "video.generation.expired",
  ]),
  created_at: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    status: z.enum(["completed", "failed", "cancelled", "expired"]),
  }),
});

// Vercel AI Gateway's delivery. It carries terminal facts only — never a URL
// and never bytes — which is why the handler below treats it as a signal to
// re-read the job rather than as the answer.
const gatewayVideoWebhookSchema = z.object({
  type: z.enum([
    "video.generation.completed",
    "video.generation.failed",
    "video.generation.cancelled",
  ]),
  data: z.object({
    jobId: z.string().min(1),
    modelId: z.string().min(1).optional(),
    status: z.enum(["completed", "failed", "cancelled"]),
  }),
});

const gatewayWebhookStatusByType = {
  "video.generation.completed": "completed",
  "video.generation.failed": "failed",
  "video.generation.cancelled": "cancelled",
} as const;

const webhookStatusByType = {
  "video.generation.completed": "completed",
  "video.generation.failed": "failed",
  "video.generation.cancelled": "cancelled",
  "video.generation.expired": "expired",
} as const;

class OpenRouterWebhookBodyTooLargeError extends Error {}

// Each provider has its own callback route, because each verifies its own
// deliveries and refuses a job that is not its. A provider with no route gets
// no URL and its jobs are finished by polling.
const VIDEO_CALLBACK_PATHS: Record<string, string> = {
  openrouter: "openrouter-callback",
  "vercel-gateway": "gateway-callback",
};

// The HTTPS origin a provider can reach this deployment on, or undefined for a
// server that has none. The same condition decides whether a callback URL is
// offered and whether pictures can be served to a provider that needs them by
// URL: a provider cannot reach a local server either way.
function publicHttpsOrigin(request: Request): string | undefined {
  let origin: URL;
  try {
    origin = new URL(process.env.PUBLIC_ORIGIN || new URL(request.url).origin);
  } catch {
    return undefined;
  }
  return origin.protocol === "https:" ? origin.origin : undefined;
}

// Providers only call back over HTTPS. A server reachable only over plain
// HTTP — a local one — gets no callback URL, and its jobs are finished by the
// poll path instead of being refused at submission.
function videoCallbackUrl(
  request: Request,
  jobId: string,
  callbackNonce: string,
  provider: string,
): string | undefined {
  const path = VIDEO_CALLBACK_PATHS[provider];
  if (path === undefined) return undefined;
  let callbackUrl: URL;
  try {
    const origin = process.env.PUBLIC_ORIGIN || new URL(request.url).origin;
    callbackUrl = new URL(
      `/api/v3/ai/videos/${encodeURIComponent(jobId)}/${path}`,
      origin,
    );
  } catch (cause) {
    throw new AiVideoSubmissionError(
      "AI video callback URL could not be constructed",
      { outcome: "definite_failure", cause },
    );
  }
  if (callbackUrl.protocol !== "https:") return undefined;
  callbackUrl.searchParams.set("nonce", callbackNonce);
  return callbackUrl.toString();
}

async function readOpenRouterWebhookBody(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_OPENROUTER_WEBHOOK_BODY_BYTES
  ) {
    throw new OpenRouterWebhookBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_OPENROUTER_WEBHOOK_BODY_BYTES) {
      const error = new OpenRouterWebhookBodyTooLargeError();
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function toVideoFrameImage(
  bytes: ArrayBuffer,
  mimeType: string,
  frameType: VideoFrameImage["frame_type"],
): VideoFrameImage {
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${arrayBufferToBase64(bytes)}`,
    },
    frame_type: frameType,
  };
}

// A reference is not a frame: the video does not pass through it, it should
// contain what it shows. The type travels beside the data because a hosted URL
// does not announce it, and a provider handed an untyped reference treats it as
// an image and warns.
function toVideoInputReference(
  bytes: ArrayBuffer,
  mimeType: string,
): VideoInputReference {
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${arrayBufferToBase64(bytes)}`,
    },
    media_type: mimeType,
  };
}

// Create a video job with POST /api/v3/ai/videos and synchronize its status
// through client-driven GET /api/v3/ai/videos/{id} polling. Submit to OpenRouter
// at creation time so the worker does not retain a long-running request.
const app = new Hono()
  .post("/", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    const requestSignal = c.req.raw.signal;
    requestSignal.throwIfAborted();

    let rawBody: unknown;
    try {
      rawBody = await parseJsonWithBodyLimit<unknown>(c.req);
    } catch (error) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: isUploadLimitExceeded(error) ? 413 : 400,
      });
    }
    const parsedBody = createSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const { prompt, durationSeconds, resolution, aspectRatio, generateAudio, seed } =
      parsedBody.data;
    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "video.generate",
      input: {
        // 名指しされたときだけ。既定が入れ替わっても同じ名前で回収できるように。
        ...(parsedBody.data.model ? { model: parsedBody.data.model } : {}),
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
      },
    });
    if (!requestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const replay = await findReplayableAiJob({ userId, ...requestIdentity });
    if (replay?.outcome === "existing") {
      // 動画は非同期なので、job そのものが答え。支払い済みのものはモデル設定を
      // 見る前に返す。
      return c.json(await publicAiJobPayload(replay.job, c.req.raw), {
        status: isTerminalAiJobStatus(replay.job.status) ? 200 : 202,
      });
    }
    if (replay?.outcome === "idempotencyConflict") {
      return c.json(await apiErrorResponse("aiRequestChanged"), { status: 409 });
    }
    if (replay?.outcome === "deleted") {
      return c.json(await apiErrorResponse("aiRequestWasDeleted"), { status: 409 });
    }

    // 回収するものが無かったので新しい依頼。ここで初めて、今のモデルがこの形を
    // 取れるかを問う。予約のあとに拒否されると、返金されたプロバイダー障害と
    // 見分けがつかなくなる。
    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve(
      "video.generate",
      parsedBody.data.model,
    );
    if (!selectedModel) {
      return c.json(await apiErrorResponse("aiModelUnavailable"), {
        status: 400,
      });
    }
    if (
      unsupportedVideoRequestReason(
        videoCapabilityOf(await loadAiVideoModelCapabilities(), selectedModel),
        {
          resolution,
          durationSeconds,
          aspectRatio,
          generateAudio,
          ...(seed === undefined ? {} : { seed }),
          promptCharacters: prompt.length,
        },
      )
    ) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const callbackNonce = await createCallbackNonce();
    const cost = selectedModel.priceUnits * durationSeconds;

    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: selectedModel.provider,
      status: "queued",
      inputParams: {
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
      },
      usageUnits: cost,
      model: selectedModel.modelId,
      activeJobLimit: 1,
      callbackNonceHash: callbackNonce.hash,
      ...requestIdentity,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;
    if (reservation.outcome === "existing") {
      return c.json(await publicAiJobPayload(job, c.req.raw), {
        status: isTerminalAiJobStatus(job.status) ? 200 : 202,
      });
    }
    if (requestSignal.aborted) {
      await failAiJobAndRefundUsage({
        userId,
        aiJobId: job.id,
        error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
        expectedProviderJobId: null,
      });
      requestSignal.throwIfAborted();
    }

    try {
      const mediaOrigin = publicHttpsOrigin(c.req.raw);
      const callbackUrl = videoCallbackUrl(
        c.req.raw,
        job.id,
        callbackNonce.nonce,
        selectedModel.provider,
      );
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        callbackNonceHash: callbackNonce.hash,
        model: selectedModel.modelId,
        provider: selectedModel.provider,
        ...(mediaOrigin === undefined ? {} : { mediaOrigin }),
        signal: requestSignal,
      });

      const current = await getAiJobById({ jobId: job.id });
      return c.json(await publicAiJobPayload(current ?? job, c.req.raw));
    } catch (err) {
      const handling = classifyVideoSubmissionFailure(err);
      if (handling.action === "refund") {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
          ...(handling.detachProviderJob ? { expectedProviderJobId: null } : {}),
        });
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (handling.action === "keepQueued") {
        console.error(
          `${selectedModel.provider} video submission outcome is unknown for AI job ${job.id}`,
          err,
        );
        return c.json(await publicAiJobPayload(job, c.req.raw));
      }
      throw err;
    }
  })
  .post("/frames", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    const requestSignal = c.req.raw.signal;
    requestSignal.throwIfAborted();

    // 契約が無ければ、大きな本文を読み込む前に断る。ただし、その名前が取りに来る
    // 価値のある job を指しているなら別——契約中に課金された結果は、契約が終わった
    // あとでも取りに来られなければならない。名前は自分の job しか指せない。
    const idempotencyKeyHash = await getAiIdempotencyKeyHash(c.req.raw);
    if (!idempotencyKeyHash) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const keyState = await aiJobStateForIdempotencyKey({
      userId,
      idempotencyKeyHash,
    });
    // 指していた job が消えているなら、本文を読む必要はない。
    if (keyState === "deleted") {
      return c.json(await apiErrorResponse("aiRequestWasDeleted"), {
        status: 409,
      });
    }

    if (keyState !== "collectable") {
      const entitlements = await getEntitlements(userId);
      const recoverableDenial = async () =>
        c.json(await apiErrorResponse("aiRequestInProgress"), { status: 409 });
      if (!entitlements.canUseAi) {
        return keyState === "none"
          ? await recoverableDenial()
          : c.json(await apiErrorResponse("aiPlanRequired"), { status: 402 });
      }
      const modelAvailability =
        entitlements.modelAvailability["video.generate"] ?? {};
      if (Object.keys(modelAvailability).length === 0) {
        return keyState === "none"
          ? await recoverableDenial()
          : c.json(await apiErrorResponse("aiModelUnavailable"), { status: 400 });
      }
      if (!entitlements.availability["video.generate"]) {
        return keyState === "none"
          ? await recoverableDenial()
          : c.json(await apiErrorResponse("aiUsageLimitExceeded"), { status: 402 });
      }
    }
    requestSignal.throwIfAborted();
    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await parseBodyWithUploadLimit(
        c.req,
        MAX_AI_VIDEO_FRAME_UPLOAD_BYTES * 2,
        aiApiMultipartBodyLimit("/api/v3/ai/videos/frames")!,
      );
    } catch (error) {
      if (isUploadLimitExceeded(error)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
      throw error;
    }
    requestSignal.throwIfAborted();
    const firstFrame = body["firstFrame"];
    const lastFrame = body["lastFrame"];
    // Reference pictures arrive as repeated `reference[]` parts, the same shape
    // the image endpoint already takes, with a single `reference` accepted too.
    // Their order is the order the prompt refers to them in.
    const listedReferences = body["reference[]"];
    const references = [
      body["reference"],
      ...(Array.isArray(listedReferences) ? listedReferences : [listedReferences]),
    ].filter((value): value is File => value instanceof File && value.size > 0);
    // A reference is a picture, a clip or a sound, told apart by what the part
    // declares. They are counted and sized separately because a model
    // publishes a separate allowance for each — MiniMax H3 takes nine
    // pictures, three clips and one sound.
    if (references.reduce((sum, file) => sum + file.size, 0) > MAX_AI_VIDEO_INPUT_REFERENCES_TOTAL_BYTES) {
      return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
    }
    const classified = references.map((file) => ({
      file,
      kind: videoReferenceKindOf(file.type),
    }));
    const unreadable = classified.find((entry) => entry.kind === null);
    if (unreadable) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const referencesOf = (kind: VideoReferenceKind) =>
      classified.filter((entry) => entry.kind === kind).map((entry) => entry.file);
    const imageReferences = referencesOf("image");
    const videoReferences = referencesOf("video");
    const audioReferences = referencesOf("audio");
    if (
      imageReferences.length > AI_MAX_VIDEO_INPUT_REFERENCES ||
      videoReferences.length > AI_MAX_VIDEO_INPUT_VIDEO_REFERENCES ||
      audioReferences.length > AI_MAX_VIDEO_INPUT_AUDIO_REFERENCES
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    for (const picture of [firstFrame, lastFrame, ...imageReferences]) {
      if (
        picture instanceof File &&
        fileExceedsUploadLimit(picture, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES)
      ) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
    }
    // Clips and sounds are held to their own sizes, and to a total: three
    // fifty-megabyte clips would be more than this Worker can carry at once,
    // however willing the model is to read them.
    for (const clip of videoReferences) {
      if (fileExceedsUploadLimit(clip, MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
      }
    }
    if (
      videoReferences.reduce((total, clip) => total + clip.size, 0) >
        MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES ||
      imageReferences.reduce((total, picture) => total + picture.size, 0) >
        MAX_AI_VIDEO_REFERENCES_TOTAL_BYTES
    ) {
      return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
    }
    for (const sound of audioReferences) {
      if (fileExceedsUploadLimit(sound, MAX_AI_VIDEO_INPUT_AUDIO_BYTES)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
      }
    }
    // Frames and references are alternatives, not a combination: a provider
    // given both ignores the references and warns, so a request asking for
    // both is refused rather than half-served after it is charged.
    const wantsReferences = references.length > 0;
    if (wantsReferences && (firstFrame !== undefined || lastFrame !== undefined)) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    // An omitted multipart field and an empty one both mean "use the default";
    // forwarding "" would fail the enum instead.
    const optionalField = (name: string) => {
      const value = body[name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const fields = createFramesSchema.safeParse({
      prompt: body["prompt"],
      durationSeconds: body["durationSeconds"],
      resolution: optionalField("resolution"),
      aspectRatio: optionalField("aspectRatio"),
      generateAudio: optionalField("generateAudio"),
      seed: optionalField("seed"),
      model: optionalField("model"),
    });
    if (
      !fields.success ||
      (!wantsReferences &&
        (!(firstFrame instanceof File) || firstFrame.size === 0)) ||
      (lastFrame !== undefined &&
        (!(lastFrame instanceof File) || lastFrame.size === 0))
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    // A PNG can expand to the full decode limit while it is inspected. Keep
    // the two validations sequential so two maximum-size frames never retain
    // their decompressed scanlines at the same time in a Worker isolate.
    const firstFrameImage = firstFrame instanceof File
      ? await validateAiInputImage(
          firstFrame,
          supportedFrameImageTypes,
          requestSignal,
        )
      : null;
    if (firstFrame instanceof File && !firstFrameImage) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();
    // Kept in the order they were sent: the prompt refers to them by position.
    const referenceImages: { bytes: ArrayBuffer; mimeType: string }[] = [];
    for (const entry of classified) {
      if (entry.kind === "image") {
        const validated = await validateAiInputImage(
          entry.file,
          supportedFrameImageTypes,
          requestSignal,
        );
        if (!validated) {
          return c.json(await apiErrorResponse("invalidRequestBody"), {
            status: 400,
          });
        }
        referenceImages.push(validated);
      } else if (entry.kind === "video") {
        // Parsed like any other clip this service handles, which also refuses
        // one whose container does not match what the part declared.
        const bytes = await entry.file.arrayBuffer();
        let metadata;
        try {
          metadata = inspectGeneratedVideo(bytes, entry.file.type);
        } catch {
          return c.json(await apiErrorResponse("invalidRequestBody"), {
            status: 400,
          });
        }
        referenceImages.push({ bytes, mimeType: metadata.mimeType });
      } else {
        // Sound. Nothing here decodes it, so the declared type — already
        // checked against a narrow allowlist — is what travels with it.
        referenceImages.push({
          bytes: await entry.file.arrayBuffer(),
          mimeType: entry.file.type.split(";", 1)[0]!.trim().toLowerCase(),
        });
      }
      requestSignal.throwIfAborted();
    }
    const lastFrameImage = lastFrame instanceof File
      ? await validateAiInputImage(
          lastFrame,
          supportedFrameImageTypes,
          requestSignal,
        )
      : null;
    if (lastFrame instanceof File && !lastFrameImage) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const { prompt, durationSeconds, resolution, aspectRatio, generateAudio, seed } =
      fields.data;
    const [firstFrameSha256, lastFrameSha256, referenceSha256s] =
      await Promise.all([
        firstFrameImage ? sha256Hex(firstFrameImage.bytes) : null,
        lastFrameImage ? sha256Hex(lastFrameImage.bytes) : null,
        Promise.all(
          referenceImages.map((reference) => sha256Hex(reference.bytes)),
        ),
      ]);
    requestSignal.throwIfAborted();
    const commonFingerprintInput = {
      ...(fields.data.model ? { model: fields.data.model } : {}),
      prompt,
      durationSeconds,
      resolution,
      aspectRatio,
      generateAudio,
      ...(seed === undefined ? {} : { seed }),
    };
    const firstFrameFingerprint = firstFrameImage
      ? { contentType: firstFrameImage.mimeType, sha256: firstFrameSha256 }
      : null;
    // The pictures are part of what was asked for, so a retry that swaps one is
    // a different request rather than a replay of this one.
    const referenceFingerprint = referenceImages.length > 0
      ? referenceImages.map((reference, index) => ({
          contentType: reference.mimeType,
          sha256: referenceSha256s[index],
        }))
      : null;
    const lastFrameFingerprint = lastFrameImage
      ? {
          contentType: lastFrameImage.mimeType,
          sha256: lastFrameSha256,
        }
      : null;
    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "video.generate.frames",
      input: {
        ...commonFingerprintInput,
        firstFrame: firstFrameFingerprint,
        ...(lastFrameFingerprint
          ? {
              lastFrame: lastFrameFingerprint,
            }
          : {}),
        ...(referenceFingerprint
          ? { inputReferences: referenceFingerprint }
          : {}),
      },
    });
    // Dashboard Server Actions originally used the text-to-video operation
    // name and provider-style frame keys. A page reload can move that exact
    // retry to this endpoint while the old reservation is still the only path
    // to a paid job. Accept that fingerprint only as a replay alias.
    const legacyRequestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "video.generate",
      input: {
        ...commonFingerprintInput,
        first_frame: firstFrameFingerprint,
        ...(lastFrameFingerprint
          ? {
              last_frame: lastFrameFingerprint,
            }
          : {}),
      },
    });
    if (!requestIdentity || !legacyRequestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const compatibleRequestFingerprints = [
      legacyRequestIdentity.requestFingerprint,
    ];

    const replay = await findReplayableAiJob({
      userId,
      ...requestIdentity,
      compatibleRequestFingerprints,
    });
    if (replay?.outcome === "existing") {
      // 動画は非同期なので、job そのものが答え。支払い済みのものはモデル設定を
      // 見る前に返す。
      return c.json(await publicAiJobPayload(replay.job, c.req.raw), {
        status: isTerminalAiJobStatus(replay.job.status) ? 200 : 202,
      });
    }
    if (replay?.outcome === "idempotencyConflict") {
      return c.json(await apiErrorResponse("aiRequestChanged"), { status: 409 });
    }
    if (replay?.outcome === "deleted") {
      return c.json(await apiErrorResponse("aiRequestWasDeleted"), { status: 409 });
    }

    // 回収するものが無かったので新しい依頼。
    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve("video.generate", fields.data.model);
    if (!selectedModel) {
      return c.json(await apiErrorResponse("aiModelUnavailable"), {
        status: 400,
      });
    }
    if (
      unsupportedVideoRequestReason(
        videoCapabilityOf(await loadAiVideoModelCapabilities(), selectedModel),
        {
          resolution,
          durationSeconds,
          aspectRatio,
          generateAudio,
          ...(seed === undefined ? {} : { seed }),
          firstFrame: firstFrame instanceof File,
          lastFrame: lastFrame instanceof File,
          inputReferences: imageReferences.length,
          videoReferences: videoReferences.length,
          audioReferences: audioReferences.length,
          // The biggest of each kind. A model states a per-reference size, and
          // the service-wide ceiling checked above can be the larger of the
          // two, so without this a reference that is legal for the service but
          // not for the chosen model is refused only after usage is reserved.
          largestInputReferenceBytes: largestBytesOf(imageReferences),
          largestVideoReferenceBytes: largestBytesOf(videoReferences),
          largestAudioReferenceBytes: largestBytesOf(audioReferences),
          promptCharacters: fields.data.prompt.length,
        },
      )
    ) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    // Expand the frames before charging. A Worker killed by its resource limit
    // cannot run a catch/finally refund, so no paid row may exist yet while the
    // request performs its largest synchronous allocation.
    let frameImages: VideoFrameImage[];
    let inputReferences: VideoInputReference[];
    try {
      frameImages = firstFrameImage
        ? [
            toVideoFrameImage(
              firstFrameImage.bytes,
              firstFrameImage.mimeType,
              "first_frame",
            ),
          ]
        : [];
      inputReferences = referenceImages.map((reference) =>
        toVideoInputReference(reference.bytes, reference.mimeType),
      );
      if (lastFrame instanceof File && lastFrameImage) {
        frameImages.push(
          toVideoFrameImage(
            lastFrameImage.bytes,
            lastFrameImage.mimeType,
            "last_frame",
          ),
        );
      }
    } catch (cause) {
      console.error("Failed to encode AI video frames", cause);
      return c.json(await apiErrorResponse("aiProviderError"), { status: 500 });
    }
    requestSignal.throwIfAborted();

    const callbackNonce = await createCallbackNonce();
    const cost = selectedModel.priceUnits * durationSeconds;
    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: selectedModel.provider,
      status: "queued",
      inputParams: {
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        ...(firstFrame instanceof File && firstFrameImage
          ? {
              firstFrame: {
                filename: firstFrame.name,
                mimeType: firstFrameImage.mimeType,
              },
            }
          : {}),
        ...(lastFrame instanceof File && lastFrameImage
          ? {
              lastFrame: {
                filename: lastFrame.name,
                mimeType: lastFrameImage.mimeType,
              },
            }
          : {}),
        ...(referenceImages.length > 0
          ? {
              inputReferences: references.map((reference, index) => ({
                filename: reference.name,
                mimeType: referenceImages[index].mimeType,
              })),
            }
          : {}),
      },
      usageUnits: cost,
      model: selectedModel.modelId,
      activeJobLimit: 1,
      callbackNonceHash: callbackNonce.hash,
      ...requestIdentity,
      compatibleRequestFingerprints,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;
    if (reservation.outcome === "existing") {
      return c.json(await publicAiJobPayload(job, c.req.raw), {
        status: isTerminalAiJobStatus(job.status) ? 200 : 202,
      });
    }
    if (requestSignal.aborted) {
      await failAiJobAndRefundUsage({
        userId,
        aiJobId: job.id,
        error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
        expectedProviderJobId: null,
      });
      requestSignal.throwIfAborted();
    }

    try {
      const mediaOrigin = publicHttpsOrigin(c.req.raw);
      const callbackUrl = videoCallbackUrl(
        c.req.raw,
        job.id,
        callbackNonce.nonce,
        selectedModel.provider,
      );

      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        ...(frameImages.length > 0 ? { frameImages } : {}),
        ...(inputReferences.length > 0 ? { inputReferences } : {}),
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        callbackNonceHash: callbackNonce.hash,
        model: selectedModel.modelId,
        provider: selectedModel.provider,
        ...(mediaOrigin === undefined ? {} : { mediaOrigin }),
        signal: requestSignal,
      });

      const current = await getAiJobById({ jobId: job.id });
      return c.json(await publicAiJobPayload(current ?? job, c.req.raw));
    } catch (err) {
      const handling = classifyVideoSubmissionFailure(err);
      if (handling.action === "refund") {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
          ...(handling.detachProviderJob ? { expectedProviderJobId: null } : {}),
        });
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (handling.action === "keepQueued") {
        console.error(
          `${selectedModel.provider} video submission outcome is unknown for AI job ${job.id}`,
          err,
        );
        return c.json(await publicAiJobPayload(job, c.req.raw));
      }
      throw err;
    }
  })
  .post("/:id/openrouter-callback", async (c) => {
    let rawBody: Uint8Array;
    try {
      rawBody = await readOpenRouterWebhookBody(c.req.raw);
    } catch (error) {
      return new Response(null, {
        status: error instanceof OpenRouterWebhookBodyTooLargeError ? 413 : 400,
      });
    }

    const signatureIsValid = await verifyOpenRouterWebhookSignature({
      rawBody,
      signatureHeader: c.req.header("X-OpenRouter-Signature"),
    });
    if (!signatureIsValid) {
      return new Response(null, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      ) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const event = openRouterVideoWebhookSchema.safeParse(payload);
    if (
      !event.success ||
      webhookStatusByType[event.data.type] !== event.data.data.status
    ) {
      return new Response(null, { status: 400 });
    }

    const jobId = c.req.param("id");
    const job = await getAiJobById({ jobId });
    const callbackNonce = c.req.query("nonce");
    if (
      !job ||
      job.kind !== "video" ||
      job.provider !== "openrouter" ||
      !job.callbackNonceHash ||
      typeof callbackNonce !== "string" ||
      !(await callbackNonceMatches(callbackNonce, job.callbackNonceHash))
    ) {
      return new Response(null, { status: 401 });
    }

    const providerJobId = event.data.data.id;
    const claimed = await claimCallbackProviderJob({
      jobId,
      job,
      provider: "openrouter",
      providerJobId,
    });
    if (!claimed.ok) return new Response(null, { status: claimed.status });
    const currentJob = claimed.job;

    // The nonce binds the signed terminal callback to this local job. The
    // provider-ID uniqueness constraint and queued-state compare-and-set above
    // prevent a callback from taking ownership from another job.
    if (
      currentJob.status !== "succeeded" &&
      currentJob.status !== "failed"
    ) {
      try {
        await synchronizeAiVideoJob({ job: currentJob });
      } catch (error) {
        console.error(
          `Failed to synchronize OpenRouter callback for AI job ${currentJob.id}`,
          error,
        );
        return new Response(null, { status: 500 });
      }
    }
    return new Response(null, { status: 204 });
  })
  // Rewrite a finished video, or continue one from where it left off.
  //
  // Both take the same shape, and differ only in which of them the provider is
  // asked for and where the length comes from: an edit is as long as its
  // source, an extension is as long as the segment that was asked for.
  .post("/:mode{edit|extend}", async (c) => {
    const mode = c.req.param("mode") === "edit" ? "edit" : "extend";
    const operation = mode === "edit" ? "video.edit" : "video.extend";
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    const requestSignal = c.req.raw.signal;
    requestSignal.throwIfAborted();

    if (!isMultipartRequest(c.req.raw)) {
      return c.json(await apiErrorResponse("invalidRequestBody"), { status: 400 });
    }
    let prompt: string;
    let requestedDuration: number | undefined;
    let requestedModel: string | undefined;
    let sourceVideo: { bytes: ArrayBuffer; mimeType: string };
    let sourceDurationSeconds: number;

    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await parseBodyWithUploadLimit(
        c.req,
        MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
        aiApiMultipartBodyLimit(`/api/v3/ai/videos/${mode}`)!,
      );
    } catch (error) {
      if (isUploadLimitExceeded(error)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
      throw error;
    }
    requestSignal.throwIfAborted();
    const file = body["sourceVideo"];
    if ("sourceJobId" in body || !(file instanceof File) || file.size === 0) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    if (fileExceedsUploadLimit(file, MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES)) {
      return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
    }
    const fields = uploadedSourceVideoSchema.safeParse({
      prompt: body["prompt"],
      ...(typeof body["durationSeconds"] === "string" &&
      body["durationSeconds"].length > 0
        ? { durationSeconds: body["durationSeconds"] }
        : {}),
      ...(typeof body["model"] === "string" && body["model"].length > 0
        ? { model: body["model"] }
        : {}),
    });
    if (!fields.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const bytes = await file.arrayBuffer();
    requestSignal.throwIfAborted();
    // The container is checked before anything is reserved, and the same
    // pass reads the length. An edit is charged for as many seconds as its
    // source runs, so that number has to come from the bytes rather than
    // from whoever sent them.
    let metadata;
    try {
      metadata = inspectGeneratedVideo(bytes, file.type);
    } catch {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    prompt = fields.data.prompt;
    requestedDuration = fields.data.durationSeconds;
    requestedModel = fields.data.model;
    sourceVideo = { bytes, mimeType: metadata.mimeType };
    sourceDurationSeconds = Math.ceil(metadata.durationSeconds);

    // An edit produces something as long as what it was given, so naming a
    // length for one would be a number nothing honours.
    if (
      (mode === "edit" && requestedDuration !== undefined) ||
      (mode === "extend" && requestedDuration === undefined)
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation,
      input: {
        ...(requestedModel ? { model: requestedModel } : {}),
        prompt,
        sourceVideoSha256: await sha256Hex(sourceVideo.bytes),
        ...(requestedDuration === undefined
          ? {}
          : { durationSeconds: requestedDuration }),
      },
    });
    if (!requestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const replay = await findReplayableAiJob({ userId, ...requestIdentity });
    if (replay?.outcome === "existing") {
      return c.json(await publicAiJobPayload(replay.job, c.req.raw), {
        status: isTerminalAiJobStatus(replay.job.status) ? 200 : 202,
      });
    }
    if (replay?.outcome === "idempotencyConflict") {
      return c.json(await apiErrorResponse("aiRequestChanged"), { status: 409 });
    }
    if (replay?.outcome === "deleted") {
      return c.json(await apiErrorResponse("aiRequestWasDeleted"), { status: 409 });
    }

    const durationSeconds = mode === "edit"
      ? sourceDurationSeconds
      : requestedDuration!;

    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve(operation, requestedModel);
    if (!selectedModel) {
      return c.json(await apiErrorResponse("aiModelUnavailable"), {
        status: 400,
      });
    }
    const selectedCapabilities = videoCapabilityOf(
      await loadAiVideoModelCapabilities(),
      selectedModel,
    );
    if (!isVideoModelUsable(selectedCapabilities, operation)) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }
    // Several models read fewer characters than this service's own limit, so a
    // prompt it accepts is one they refuse.
    if (
      (selectedCapabilities !== undefined &&
        (prompt.length > selectedCapabilities.maxPromptCharacters ||
          (mode === "extend" && selectedCapabilities.durations.length > 0 &&
            !selectedCapabilities.durations.includes(durationSeconds)))) ||
      sourceVideoOutsideModelRange(selectedCapabilities, {
        bytes: sourceVideo.bytes.byteLength,
        durationSeconds: sourceDurationSeconds,
      })
    ) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const callbackNonce = await createCallbackNonce();
    const cost = selectedModel.priceUnits * durationSeconds;
    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: selectedModel.provider,
      status: "queued",
      inputParams: {
        prompt,
        durationSeconds,
        mode,
      },
      usageUnits: cost,
      model: selectedModel.modelId,
      activeJobLimit: 1,
      callbackNonceHash: callbackNonce.hash,
      ...requestIdentity,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;
    if (reservation.outcome === "existing") {
      return c.json(await publicAiJobPayload(job, c.req.raw), {
        status: isTerminalAiJobStatus(job.status) ? 200 : 202,
      });
    }

    try {
      const mediaOrigin = publicHttpsOrigin(c.req.raw);
      const callbackUrl = videoCallbackUrl(
        c.req.raw,
        job.id,
        callbackNonce.nonce,
        selectedModel.provider,
      );
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        // The shape is the source's; naming one here would be a number the
        // provider discards. Something has to be sent, so it is the default.
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
        mode,
        sourceVideo,
        callbackNonceHash: callbackNonce.hash,
        model: selectedModel.modelId,
        provider: selectedModel.provider,
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        ...(mediaOrigin === undefined ? {} : { mediaOrigin }),
        signal: requestSignal,
      });
      const current = await getAiJobById({ jobId: job.id });
      return c.json(await publicAiJobPayload(current ?? job, c.req.raw));
    } catch (err) {
      const handling = classifyVideoSubmissionFailure(err);
      if (handling.action === "refund") {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
          ...(handling.detachProviderJob
            ? { expectedProviderJobId: null }
            : {}),
        });
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (handling.action === "keepQueued") {
        // The provider may have taken the job: its answer was lost, not
        // refused. Reporting a failure here would have the client drop the
        // idempotency key and start a second paid generation once the slot
        // clears, while the first one is still queued and may yet arrive by
        // callback. The queued job is what the generation routes return, and
        // what the client can keep polling.
        console.error(
          `${selectedModel.provider} video submission outcome is unknown for AI job ${job.id}`,
          err,
        );
        return c.json(await publicAiJobPayload(job, c.req.raw));
      }
      throw err;
    }
  })

  // Put a finished video's motion onto a character picture.
  .post("/motion", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    const requestSignal = c.req.raw.signal;
    requestSignal.throwIfAborted();

    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await parseBodyWithUploadLimit(
        c.req,
        // The largest single part this route takes. The character picture is
        // held to its own, smaller limit below.
        MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
        aiApiMultipartBodyLimit("/api/v3/ai/videos/motion")!,
      );
    } catch (error) {
      if (isUploadLimitExceeded(error)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
      }
      throw error;
    }
    requestSignal.throwIfAborted();

    if ("sourceJobId" in body) {
      return c.json(await apiErrorResponse("invalidRequestBody"), { status: 400 });
    }

    const characterImage = body["characterImage"];
    if (
      !(characterImage instanceof File) ||
      characterImage.size === 0 ||
      fileExceedsUploadLimit(characterImage, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES)
    ) {
      return c.json(
        await apiErrorResponse(
          characterImage instanceof File
            ? "fileIsTooLarge"
            : "invalidRequestBody",
        ),
        { status: characterImage instanceof File ? 413 : 400 },
      );
    }

    const optionalField = (name: string) => {
      const value = body[name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const fields = motionSchema.safeParse({
      prompt: body["prompt"],
      durationSeconds: body["durationSeconds"],
      orientation: optionalField("orientation"),
      quality: optionalField("quality"),
      model: optionalField("model"),
    });
    if (!fields.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const uploadedSource = body["sourceVideo"];
    if (!(uploadedSource instanceof File) || uploadedSource.size === 0) {
      return c.json(await apiErrorResponse("invalidRequestBody"), { status: 400 });
    }
    const file = uploadedSource as File;
    if (fileExceedsUploadLimit(file, MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES)) {
      return c.json(await apiErrorResponse("fileIsTooLarge"), { status: 413 });
    }
    const bytes = await file.arrayBuffer();
    requestSignal.throwIfAborted();
    // Validate the uploaded container before reserving any usage.
    let metadata;
    try {
      metadata = inspectGeneratedVideo(bytes, file.type);
    } catch {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const sourceVideo = { bytes, mimeType: metadata.mimeType };
    const sourceVideoSha256 = await sha256Hex(bytes);
    const sourceDurationSeconds = Math.ceil(metadata.durationSeconds);

    const validatedImage = await validateAiInputImage(
      characterImage,
      supportedFrameImageTypes,
      requestSignal,
    );
    if (!validatedImage) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const { prompt, durationSeconds, orientation, quality } =
      fields.data;
    const characterSha256 = await sha256Hex(validatedImage.bytes);
    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "video.motion",
      input: {
        ...(fields.data.model ? { model: fields.data.model } : {}),
        prompt,
        sourceVideoSha256,
        durationSeconds,
        orientation,
        quality,
        characterImage: {
          contentType: validatedImage.mimeType,
          sha256: characterSha256,
        },
      },
    });
    if (!requestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const replay = await findReplayableAiJob({ userId, ...requestIdentity });
    if (replay?.outcome === "existing") {
      return c.json(await publicAiJobPayload(replay.job, c.req.raw), {
        status: isTerminalAiJobStatus(replay.job.status) ? 200 : 202,
      });
    }
    if (replay?.outcome === "idempotencyConflict") {
      return c.json(await apiErrorResponse("aiRequestChanged"), { status: 409 });
    }
    if (replay?.outcome === "deleted") {
      return c.json(await apiErrorResponse("aiRequestWasDeleted"), { status: 409 });
    }

    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve("video.motion", fields.data.model);
    if (!selectedModel) {
      return c.json(await apiErrorResponse("aiModelUnavailable"), {
        status: 400,
      });
    }
    const motionCapabilities = videoCapabilityOf(
      await loadAiVideoModelCapabilities(),
      selectedModel,
    );
    if (!isVideoModelUsable(motionCapabilities, "video.motion")) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }
    if (
      (motionCapabilities !== undefined &&
        (prompt.length > motionCapabilities.maxPromptCharacters ||
          (motionCapabilities.durations.length > 0 &&
            !motionCapabilities.durations.includes(durationSeconds)))) ||
      (sourceDurationSeconds !== null &&
        sourceVideoOutsideModelRange(motionCapabilities, {
          bytes: sourceVideo.bytes.byteLength,
          durationSeconds: sourceDurationSeconds,
        }))
    ) {
      return c.json(await apiErrorResponse("aiModelDoesNotSupportRequest"), {
        status: 400,
      });
    }
    requestSignal.throwIfAborted();

    const callbackNonce = await createCallbackNonce();
    const cost = selectedModel.priceUnits * durationSeconds;
    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: selectedModel.provider,
      status: "queued",
      inputParams: {
        prompt,
        durationSeconds,
        orientation,
        quality,
        mode: "motion",
        characterImage: {
          filename: characterImage.name,
          mimeType: validatedImage.mimeType,
        },
      },
      usageUnits: cost,
      model: selectedModel.modelId,
      activeJobLimit: 1,
      callbackNonceHash: callbackNonce.hash,
      ...requestIdentity,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;
    if (reservation.outcome === "existing") {
      return c.json(await publicAiJobPayload(job, c.req.raw), {
        status: isTerminalAiJobStatus(job.status) ? 200 : 202,
      });
    }

    try {
      const mediaOrigin = publicHttpsOrigin(c.req.raw);
      const callbackUrl = videoCallbackUrl(
        c.req.raw,
        job.id,
        callbackNonce.nonce,
        selectedModel.provider,
      );
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        // The result follows the character picture or the reference video, so
        // neither is chosen here; something has to be sent, so it is the default.
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
        // The character travels as the one picture a motion request carries.
        frameImages: [
          toVideoFrameImage(
            validatedImage.bytes,
            validatedImage.mimeType,
            "first_frame",
          ),
        ],
        mode: "motion",
        sourceVideo,
        motionOrientation: orientation,
        motionQuality: quality,
        callbackNonceHash: callbackNonce.hash,
        model: selectedModel.modelId,
        provider: selectedModel.provider,
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        ...(mediaOrigin === undefined ? {} : { mediaOrigin }),
        signal: requestSignal,
      });
      const current = await getAiJobById({ jobId: job.id });
      return c.json(await publicAiJobPayload(current ?? job, c.req.raw));
    } catch (err) {
      const handling = classifyVideoSubmissionFailure(err);
      if (handling.action === "refund") {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
          ...(handling.detachProviderJob
            ? { expectedProviderJobId: null }
            : {}),
        });
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (handling.action === "keepQueued") {
        // The provider may have taken the job: its answer was lost, not
        // refused. Reporting a failure here would have the client drop the
        // idempotency key and start a second paid generation once the slot
        // clears, while the first one is still queued and may yet arrive by
        // callback. The queued job is what the generation routes return, and
        // what the client can keep polling.
        console.error(
          `${selectedModel.provider} video submission outcome is unknown for AI job ${job.id}`,
          err,
        );
        return c.json(await publicAiJobPayload(job, c.req.raw));
      }
      throw err;
    }
  })

  // Vercel AI Gateway's terminal delivery.
  //
  // What makes this safe is not the payload: it is the per-job nonce in the
  // query string, which only this service and the Gateway ever saw, plus the
  // fact that nothing here is believed. The delivery says a job of ours
  // finished; `synchronizeAiVideoJob` then asks the provider what actually
  // happened and decides the outcome from that answer. A forged call can
  // therefore cost at most one poll, which the job's own poll lease already
  // bounds.
  //
  // The Gateway also signs each delivery, with a secret it returns once on the
  // start response — per job, not per workspace. Verifying that signature
  // would mean keeping those secrets in the database in the clear, which this
  // service deliberately does not do for provider credentials; the nonce gives
  // the same guarantee for a payload that is only a trigger. If the signature
  // is wanted later, capture `providerMetadata.gateway.asyncJob.webhookSigningSecret`
  // in the Gateway adapter's `start` and store it beside the job.
  .post("/:id/gateway-callback", async (c) => {
    let rawBody: Uint8Array;
    try {
      rawBody = await readOpenRouterWebhookBody(c.req.raw);
    } catch (error) {
      return new Response(null, {
        status: error instanceof OpenRouterWebhookBodyTooLargeError ? 413 : 400,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      ) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const event = gatewayVideoWebhookSchema.safeParse(payload);
    if (
      !event.success ||
      gatewayWebhookStatusByType[event.data.type] !== event.data.data.status
    ) {
      return new Response(null, { status: 400 });
    }

    const jobId = c.req.param("id");
    const job = await getAiJobById({ jobId });
    const callbackNonce = c.req.query("nonce");
    if (
      !job ||
      job.kind !== "video" ||
      job.provider !== "vercel-gateway" ||
      !job.callbackNonceHash ||
      typeof callbackNonce !== "string" ||
      !(await callbackNonceMatches(callbackNonce, job.callbackNonceHash))
    ) {
      return new Response(null, { status: 401 });
    }

    // The Gateway names the job on the start response, but that response is
    // not always seen: a transport timeout leaves the submission classified
    // as unknown and the job queued with no id. This delivery is then the only
    // thing carrying it, so it attaches under the same guards OpenRouter's
    // does rather than being refused.
    const claimed = await claimCallbackProviderJob({
      jobId,
      job,
      provider: "vercel-gateway",
      providerJobId: event.data.data.jobId,
    });
    if (!claimed.ok) return new Response(null, { status: claimed.status });
    const currentJob = claimed.job;

    if (currentJob.status !== "succeeded" && currentJob.status !== "failed") {
      try {
        await synchronizeAiVideoJob({ job: currentJob });
      } catch (error) {
        console.error(
          `Failed to synchronize Vercel AI Gateway callback for AI job ${currentJob.id}`,
          error,
        );
        return new Response(null, { status: 500 });
      }
    }
    // The Gateway expects a 2xx inside ten seconds and retries otherwise, with
    // the same x-ai-gateway-idempotency-key; a repeat lands on the terminal
    // status check above and does nothing.
    return new Response(null, { status: 204 });
  })
  // The pictures a submitted job works from, for the provider to fetch.
  //
  // Unauthenticated on purpose: a provider holds no account here, and there is
  // no header it could be told to send. The URL is the capability — a job id
  // and a media id, both UUIDs — and the route reads nothing outside the one
  // prefix those two build, so no other object in the bucket is reachable
  // through it. The objects are opaque picture bytes a caller uploaded moments
  // earlier for this job, carry nothing about the account, and are scheduled
  // for deletion as they are written.
  .get("/media/:jobId/:mediaId", async (c) => {
    const jobId = c.req.param("jobId");
    const mediaId = c.req.param("mediaId");
    if (!isVideoInputMediaId(jobId) || !isVideoInputMediaId(mediaId)) {
      return new Response(null, { status: 404 });
    }

    let media: Awaited<ReturnType<typeof readVideoInputMedia>>;
    try {
      media = await readVideoInputMedia({ jobId, mediaId });
    } catch (error) {
      console.error(
        `Failed to read AI video input media for job ${jobId}`,
        error,
      );
      return new Response(null, { status: 500 });
    }
    if (!media) return new Response(null, { status: 404 });

    // The type is not read back from the object: a provider only needs bytes,
    // and echoing a stored type would hand back something a caller chose.
    const headers = {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    return media.body
      ? new Response(media.body, { headers })
      : new Response(media.bytes, { headers });
  })
  .get("/:id", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const jobId = c.req.param("id");
    const job = await getAiJobById({ jobId });
    if (!job || job.userId !== userId) {
      return c.json(await apiErrorResponse("aiJobNotFound"), {
        status: 404,
      });
    }

    try {
      const current =
        isTerminalAiJobStatus(job.status)
          ? job
          : !job.providerJobId
            ? job
            : await synchronizeAiVideoJob({ job });
      if (!current) {
        return c.json(await apiErrorResponse("aiJobNotFound"), {
          status: 404,
        });
      }
      return c.json(await publicAiJobPayload(current, c.req.raw));
    } catch (err) {
      if (err instanceof AiProviderError) {
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      throw err;
    }
  });

export default app;

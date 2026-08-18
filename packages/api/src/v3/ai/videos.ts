import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import { getEntitlements } from "../../ai/entitlements";
import {
  fileExceedsUploadLimit,
  isUploadLimitExceeded,
  MAX_AI_PROMPT_LENGTH,
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
import {
  classifyVideoSubmissionFailure,
  createAndAttachVideoJob,
  synchronizeAiVideoJob,
} from "../../ai/video-jobs";
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
  AI_VIDEO_DURATION_STRINGS,
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
  durationSeconds: z
    .enum(AI_VIDEO_DURATION_STRINGS)
    .transform((value) => Number(value)),
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

const webhookStatusByType = {
  "video.generation.completed": "completed",
  "video.generation.failed": "failed",
  "video.generation.cancelled": "cancelled",
  "video.generation.expired": "expired",
} as const;

class OpenRouterWebhookBodyTooLargeError extends Error {}

function openRouterVideoCallbackUrl(
  request: Request,
  jobId: string,
  callbackNonce: string,
): string {
  try {
    const origin = process.env.PUBLIC_ORIGIN || new URL(request.url).origin;
    const callbackUrl = new URL(
      `/api/v3/ai/videos/${encodeURIComponent(jobId)}/openrouter-callback`,
      origin,
    );
    callbackUrl.searchParams.set("nonce", callbackNonce);
    return callbackUrl.toString();
  } catch (cause) {
    throw new AiVideoSubmissionError(
      "OpenRouter video callback URL could not be constructed",
      { outcome: "definite_failure", cause },
    );
  }
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

    const { prompt, durationSeconds, resolution, aspectRatio, generateAudio, seed } =
      parsedBody.data;
    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve(
      "video.generate",
      parsedBody.data.model,
    );
    if (!selectedModel) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "video.generate",
      input: {
        model: selectedModel.modelId,
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
    const callbackNonce = await createCallbackNonce();
    const cost = selectedModel.priceUnits * durationSeconds;

    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: "openrouter",
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

    try {
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        callbackUrl: openRouterVideoCallbackUrl(
          c.req.raw,
          job.id,
          callbackNonce.nonce,
        ),
        callbackNonceHash: callbackNonce.hash,
        model: selectedModel.modelId,
        signal: c.req.raw.signal,
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
          `OpenRouter video submission outcome is unknown for AI job ${job.id}`,
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

    const entitlements = await getEntitlements(userId);
    if (!entitlements.canUseAi) {
      return c.json(await apiErrorResponse("aiPlanRequired"), {
        status: 402,
      });
    }
    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await parseBodyWithUploadLimit(
        c.req,
        MAX_AI_VIDEO_FRAME_UPLOAD_BYTES * 2,
      );
    } catch (error) {
      if (isUploadLimitExceeded(error)) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
      throw error;
    }
    const firstFrame = body["firstFrame"];
    const lastFrame = body["lastFrame"];
    for (const frame of [firstFrame, lastFrame]) {
      if (
        frame instanceof File &&
        fileExceedsUploadLimit(frame, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES)
      ) {
        return c.json(await apiErrorResponse("fileIsTooLarge"), {
          status: 413,
        });
      }
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
      !(firstFrame instanceof File) ||
      firstFrame.size === 0 ||
      (lastFrame !== undefined &&
        (!(lastFrame instanceof File) || lastFrame.size === 0))
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const [firstFrameImage, lastFrameImage] = await Promise.all([
      validateAiInputImage(firstFrame, supportedFrameImageTypes),
      lastFrame instanceof File
        ? validateAiInputImage(lastFrame, supportedFrameImageTypes)
        : null,
    ]);
    if (
      !firstFrameImage ||
      (lastFrame instanceof File && !lastFrameImage)
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const { prompt, durationSeconds, resolution, aspectRatio, generateAudio, seed } =
      fields.data;
    const [firstFrameSha256, lastFrameSha256] = await Promise.all([
      sha256Hex(firstFrameImage.bytes),
      lastFrameImage ? sha256Hex(lastFrameImage.bytes) : null,
    ]);
    const catalog = await loadAiModelCatalog();
    const selectedModel = catalog.resolve("video.generate", fields.data.model);
    if (!selectedModel) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const requestIdentity = await getAiRequestIdentity({
      request: c.req.raw,
      operation: "video.generate.frames",
      input: {
        model: selectedModel.modelId,
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        firstFrame: {
          contentType: firstFrameImage.mimeType,
          sha256: firstFrameSha256,
        },
        ...(lastFrameImage
          ? {
              lastFrame: {
                contentType: lastFrameImage.mimeType,
                sha256: lastFrameSha256,
              },
            }
          : {}),
      },
    });
    if (!requestIdentity) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const callbackNonce = await createCallbackNonce();
    const frameImages = [
      toVideoFrameImage(
        firstFrameImage.bytes,
        firstFrameImage.mimeType,
        "first_frame",
      ),
    ];
    if (lastFrame instanceof File && lastFrameImage) {
      frameImages.push(
        toVideoFrameImage(
          lastFrameImage.bytes,
          lastFrameImage.mimeType,
          "last_frame",
        ),
      );
    }

    const cost = selectedModel.priceUnits * durationSeconds;
    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      inputParams: {
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        firstFrame: {
          filename: firstFrame.name,
          mimeType: firstFrameImage.mimeType,
        },
        ...(lastFrame instanceof File && lastFrameImage
          ? {
              lastFrame: {
                filename: lastFrame.name,
                mimeType: lastFrameImage.mimeType,
              },
            }
          : {}),
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
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        resolution,
        aspectRatio,
        generateAudio,
        ...(seed === undefined ? {} : { seed }),
        frameImages,
        callbackUrl: openRouterVideoCallbackUrl(
          c.req.raw,
          job.id,
          callbackNonce.nonce,
        ),
        callbackNonceHash: callbackNonce.hash,
        model: selectedModel.modelId,
        signal: c.req.raw.signal,
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
          `OpenRouter video submission outcome is unknown for AI job ${job.id}`,
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
    let currentJob = job;
    if (job.providerJobId === null) {
      try {
        const attachment = await attachProviderJobIdToQueuedAiJob({
          jobId,
          kind: "video",
          provider: "openrouter",
          providerJobId,
          expectedCallbackNonceHash: job.callbackNonceHash,
        });
        if (
          attachment.outcome === "notFound" ||
          attachment.outcome === "conflict"
        ) {
          return new Response(null, { status: 409 });
        }
        const attachedJob = await getAiJobById({ jobId });
        if (attachedJob?.providerJobId !== providerJobId) {
          return new Response(null, { status: 409 });
        }
        currentJob = attachedJob;
      } catch (attachmentError) {
        let latestJob: Awaited<ReturnType<typeof getAiJobById>>;
        let providerOwner: Awaited<ReturnType<typeof getAiJobByProviderJobId>>;
        try {
          [latestJob, providerOwner] = await Promise.all([
            getAiJobById({ jobId }),
            getAiJobByProviderJobId({
              provider: "openrouter",
              providerJobId,
            }),
          ]);
        } catch (verificationError) {
          console.error(
            `Failed to verify OpenRouter callback attachment for AI job ${jobId}`,
            new AggregateError([attachmentError, verificationError]),
          );
          return new Response(null, { status: 500 });
        }
        if (
          (providerOwner && providerOwner.id !== jobId) ||
          (latestJob?.providerJobId !== null &&
            latestJob?.providerJobId !== providerJobId)
        ) {
          return new Response(null, { status: 409 });
        }
        if (
          latestJob?.providerJobId !== providerJobId ||
          providerOwner?.id !== jobId
        ) {
          console.error(
            `Failed to attach OpenRouter callback provider job to AI job ${jobId}`,
            attachmentError,
          );
          return new Response(null, { status: 500 });
        }
        currentJob = latestJob;
      }
    } else if (job.providerJobId !== providerJobId) {
      return new Response(null, { status: 409 });
    }

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

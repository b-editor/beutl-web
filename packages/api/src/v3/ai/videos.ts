import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { loadAiSettings } from "../../ai/settings";
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
  createVideoJob,
  isDefiniteVideoSubmissionFailure,
  verifyOpenRouterWebhookSignature,
  type VideoFrameImage,
} from "../../ai/openrouter";
import { synchronizeAiVideoJob } from "../../ai/video-jobs";
import {
  validateAiInputImage,
  type AiInputImageMimeType,
} from "../../ai/input-image-validation";
import {
  attachProviderJobIdToQueuedAiJob,
  enqueueAiRemoteJobCleanup,
  getAiJobById,
} from "@beutl/db";
import { getContentUrl } from "../../content-url";
import {
  AI_JOB_FAILURE_MESSAGES,
  PUBLIC_AI_JOB_ERROR,
} from "../../ai/job-errors";

const createSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
  resolution: z.enum(["720p", "1080p"]).default("720p"),
}).strict();

const createFramesSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z
    .enum(["4", "6", "8"])
    .transform((value) => Number(value)),
  resolution: z.enum(["720p", "1080p"]).default("720p"),
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

class DetachedRemoteVideoJobError extends AiProviderError {}

class OpenRouterWebhookBodyTooLargeError extends Error {}

function openRouterVideoCallbackUrl(request: Request, jobId: string): string {
  try {
    const origin = process.env.PUBLIC_ORIGIN || new URL(request.url).origin;
    return new URL(
      `/api/v3/ai/videos/${encodeURIComponent(jobId)}/openrouter-callback`,
      origin,
    ).toString();
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

async function createAndAttachVideoJob({
  jobId,
  prompt,
  durationSeconds,
  resolution,
  frameImages,
  callbackUrl,
  model,
}: {
  jobId: string;
  prompt: string;
  durationSeconds: number;
  resolution: "720p" | "1080p";
  frameImages?: VideoFrameImage[];
  callbackUrl: string;
  model: string;
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
  });
  let attachment: Awaited<ReturnType<typeof attachProviderJobIdToQueuedAiJob>>;
  try {
    attachment = await attachProviderJobIdToQueuedAiJob({
      jobId,
      kind: "video",
      provider: "openrouter",
      providerJobId: providerJob.id,
    });
  } catch (cause) {
    throw new AiProviderError(
      "AI video job attachment could not be confirmed",
      { cause },
    );
  }
  if (
    attachment.outcome === "notFound" ||
    attachment.outcome === "conflict"
  ) {
    await enqueueAiRemoteJobCleanup({
      provider: "openrouter",
      providerJobId: providerJob.id,
    });
    throw new DetachedRemoteVideoJobError(
      "AI video job was deleted after remote submission",
    );
  }
  return providerJob;
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

// 動画生成: POST /api/v3/ai/videos (ジョブ作成)
// クライアント駆動ポーリング: GET /api/v3/ai/videos/{id} で状態を確認する。
// Workers で長時間処理を持たないため、ジョブ作成時に OpenRouter へ投入し、
// ポーリング時に状態を同期する。
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

    const { prompt, durationSeconds, resolution } = parsedBody.data;
    const settings = await loadAiSettings();
    const cost = settings.getPrice("video.generate") * durationSeconds;

    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      inputParams: { prompt, durationSeconds, resolution },
      usageUnits: cost,
      activeJobLimit: 1,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;

    try {
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        resolution,
        callbackUrl: openRouterVideoCallbackUrl(c.req.raw, job.id),
        model: settings.getModel("video.generate"),
      });

      return c.json({
        jobId: job.id,
        status: "running",
      });
    } catch (err) {
      if (err instanceof DetachedRemoteVideoJobError) {
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (isDefiniteVideoSubmissionFailure(err)) {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
        });
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (err instanceof AiProviderError) {
        console.error(
          `OpenRouter video submission outcome is unknown for AI job ${job.id}`,
          err,
        );
        return c.json({
          jobId: job.id,
          status: "running",
        });
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

    const fields = createFramesSchema.safeParse({
      prompt: body["prompt"],
      durationSeconds: body["durationSeconds"],
      resolution: body["resolution"] ?? undefined,
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

    const { prompt, durationSeconds, resolution } = fields.data;
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

    const settings = await loadAiSettings();
    const cost = settings.getPrice("video.generate") * durationSeconds;
    const reservation = await createReservedAiJob({
      userId,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      inputParams: {
        prompt,
        durationSeconds,
        resolution,
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
      activeJobLimit: 1,
    });
    if (!reservation.ok) {
      return c.json(await apiErrorResponse(reservation.errorCode), {
        status: reservation.status,
      });
    }
    const { job } = reservation;

    try {
      await createAndAttachVideoJob({
        jobId: job.id,
        prompt,
        durationSeconds,
        resolution,
        frameImages,
        callbackUrl: openRouterVideoCallbackUrl(c.req.raw, job.id),
        model: settings.getModel("video.generate"),
      });

      return c.json({
        jobId: job.id,
        status: "running",
      });
    } catch (err) {
      if (err instanceof DetachedRemoteVideoJobError) {
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (isDefiniteVideoSubmissionFailure(err)) {
        await failAiJobAndRefundUsage({
          userId,
          aiJobId: job.id,
          error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
        });
        return c.json(await apiErrorResponse("aiProviderError"), {
          status: 500,
        });
      }
      if (err instanceof AiProviderError) {
        console.error(
          `OpenRouter video submission outcome is unknown for AI job ${job.id}`,
          err,
        );
        return c.json({
          jobId: job.id,
          status: "running",
        });
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

    const providerJobId = event.data.data.id;
    const attachment = await attachProviderJobIdToQueuedAiJob({
      jobId: c.req.param("id"),
      kind: "video",
      provider: "openrouter",
      providerJobId,
    });
    if (
      attachment.outcome === "notFound" ||
      attachment.outcome === "conflict"
    ) {
      await enqueueAiRemoteJobCleanup({
        provider: "openrouter",
        providerJobId,
      });
      return new Response(null, { status: 204 });
    }

    // Provider-ID attachment is a durable compare-and-set. Together with the
    // canonical synchronization leases, it makes repeated webhook deliveries
    // safe without trusting the event payload as the source of job state.
    if (
      attachment.job.status !== "succeeded" &&
      attachment.job.status !== "failed"
    ) {
      try {
        await synchronizeAiVideoJob({ job: attachment.job });
      } catch (error) {
        console.error(
          `Failed to synchronize OpenRouter callback for AI job ${attachment.job.id}`,
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
        job.status === "succeeded" || job.status === "failed"
          ? job
          : !job.providerJobId
            ? job
            : await synchronizeAiVideoJob({ job });
      if (!current) {
        return c.json(await apiErrorResponse("aiJobNotFound"), {
          status: 404,
        });
      }
      return c.json({
        jobId: current.id,
        status:
          current.status === "queued" || current.status === "finalizing"
            ? "running"
            : current.status,
        fileId: current.resultFileId,
        url: current.resultFileId
          ? await getContentUrl(current.resultFileId, c.req.raw)
          : null,
        error: current.status === "failed" ? PUBLIC_AI_JOB_ERROR : null,
      });
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

import {
  getAiJobByUserId,
  finalizeAiJobDeletionByUserId,
  listAiJobsByUserId,
  prepareAiJobDeletionByUserId,
  type AiJobHistoryCursor,
} from "@beutl/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { deleteAiOutputObject } from "../../ai/storage";
import { MAX_AI_PROMPT_LENGTH } from "../../ai/upload-limits";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_TASKS,
  AI_LEGACY_IMAGE_SIZES,
  AI_MAX_SEED,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_RESOLUTIONS,
  isAiVideoDurationSeconds,
} from "@beutl/core";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import { getContentUrl } from "../../content-url";
import { PUBLIC_AI_JOB_ERROR } from "../../ai/job-errors";
import { publicAiJobStatus, type PublicAiJobStatus } from "../../ai/job-response";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const listQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
  })
  .strict();

const pathParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

const cursorPayloadSchema = z
  .object({
    createdAt: z.string().refine((value) => {
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date.toISOString() === value;
    }),
    id: z.string().uuid(),
  })
  .strict();

// Jobs created before aspect ratios existed carry `size`; new ones carry
// `aspectRatio`. Both have to render in the history, and both can be rerun.
const imageRetryInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
    size: z.enum(AI_LEGACY_IMAGE_SIZES).optional(),
    aspectRatio: z.enum(AI_IMAGE_ASPECT_RATIOS).optional(),
    background: z.enum(AI_IMAGE_BACKGROUNDS).optional(),
    seed: z.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
    // Only the names are kept; the pictures themselves are not, which is what
    // closes retry for a reference-guided generation. "reference" is what jobs
    // recorded while only one was allowed.
    reference: z.object({ filename: z.string().min(1) }).optional(),
    references: z
      .array(z.object({ filename: z.string().min(1) }))
      .optional(),
  })
  .refine(
    (value) => value.size !== undefined || value.aspectRatio !== undefined,
  );

// A frame-conditioned video records which images it started from. The bytes are
// not kept, so such a job cannot be rerun — but the history has to say the
// frames were there, or it reads as a plain text-to-video job.
const videoFrameHistorySchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

const videoHistoryInputSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z
    .number()
    .refine(isAiVideoDurationSeconds),
  resolution: z.enum(AI_VIDEO_RESOLUTIONS).default("720p"),
  aspectRatio: z.enum(AI_VIDEO_ASPECT_RATIOS).optional(),
  generateAudio: z.boolean().optional(),
  seed: z.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
  firstFrame: videoFrameHistorySchema.optional(),
  lastFrame: videoFrameHistorySchema.optional(),
});

const imageEditHistoryInputSchema = z.object({
  task: z.enum(AI_IMAGE_EDIT_TASKS),
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH).optional(),
});

const transcriptionHistoryInputSchema = z.object({
  durationSeconds: z.number().finite().nonnegative(),
  language: z.string().length(2).optional(),
});

const translationHistoryInputSchema = z.object({
  sourceLanguage: z.string().length(2).optional(),
  targetLanguage: z.string().length(2),
  segmentCount: z.number().int().positive(),
  characterCount: z.number().int().positive(),
});

type AiJobRecord = NonNullable<
  Awaited<ReturnType<typeof getAiJobByUserId>>
>;

export type AiJobSummary = {
  id: string;
  kind: string;
  status: PublicAiJobStatus;
  inputParams: Record<string, unknown> | null;
  // The model the job ran on, or null for jobs created before an operation
  // could offer more than one.
  model: string | null;
  fileId: string | null;
  url: string | null;
  fileName: string | null;
  contentType: string | null;
  error: string | null;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
};

async function authenticatedUserId(c: Context): Promise<string | null> {
  try {
    return await getUserId(c);
  } catch {
    return null;
  }
}

function encodeCursor(cursor: AiJobHistoryCursor): string {
  return btoa(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function decodeCursor(value: string): AiJobHistoryCursor | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = base64.length % 4;
    if (remainder === 1) {
      return null;
    }
    const padding = remainder === 0 ? "" : "=".repeat(4 - remainder);
    const parsed = cursorPayloadSchema.safeParse(
      JSON.parse(atob(base64 + padding)),
    );
    if (!parsed.success) {
      return null;
    }
    return {
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id,
    };
  } catch {
    return null;
  }
}

function canRetry(job: AiJobRecord): boolean {
  if (
    job.status !== "succeeded" &&
    job.status !== "failed"
  ) {
    return false;
  }
  if (job.kind === "image") {
    const parsed = imageRetryInputSchema.safeParse(job.inputParams);
    // Same rule as a frame-conditioned video: the reference image was not kept,
    // so rerunning would produce something else and charge for it.
    return parsed.success && !parsed.data.reference && !parsed.data.references;
  }
  if (job.kind === "video") {
    const parsed = videoHistoryInputSchema.safeParse(job.inputParams);
    // Rerunning a frame-conditioned video would silently drop the frames it was
    // conditioned on and produce something else at full price. Until the frames
    // themselves are retained, only text-to-video can be repeated.
    return parsed.success && !parsed.data.firstFrame && !parsed.data.lastFrame;
  }
  return false;
}

function sanitizedInputParams(job: AiJobRecord): Record<string, unknown> | null {
  const parsed = (() => {
    switch (job.kind) {
      case "image":
        return imageRetryInputSchema.safeParse(job.inputParams);
      case "image_edit":
        return imageEditHistoryInputSchema.safeParse(job.inputParams);
      case "video":
        return videoHistoryInputSchema.safeParse(job.inputParams);
      case "stt":
        return transcriptionHistoryInputSchema.safeParse(job.inputParams);
      case "translation":
        return translationHistoryInputSchema.safeParse(job.inputParams);
      default:
        return null;
    }
  })();

  return parsed?.success ? parsed.data : null;
}

async function toSummary(
  job: AiJobRecord,
  request: Request,
): Promise<AiJobSummary> {
  return {
    id: job.id,
    kind: job.kind,
    status: publicAiJobStatus(job.status),
    inputParams: sanitizedInputParams(job),
    model: job.model,
    fileId: job.resultFileId,
    url: job.resultFileId
      ? await getContentUrl(job.resultFileId, request)
      : null,
    fileName: job.resultFile?.name ?? null,
    contentType: job.resultFile?.mimeType ?? null,
    error: job.status === "failed" ? PUBLIC_AI_JOB_ERROR : null,
    canRetry: canRetry(job),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const app = new Hono()
  .get("/", async (c) => {
    const userId = await authenticatedUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    let cursor: AiJobHistoryCursor | undefined;
    if (query.data.cursor) {
      const decoded = decodeCursor(query.data.cursor);
      if (!decoded) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 400,
        });
      }
      cursor = decoded;
    }

    const page = await listAiJobsByUserId({
      userId,
      cursor,
      limit: query.data.limit,
    });
    return c.json({
      jobs: await Promise.all(
        page.jobs.map((job) => toSummary(job, c.req.raw)),
      ),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  })
  .get("/:id", async (c) => {
    const userId = await authenticatedUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const params = pathParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const job = await getAiJobByUserId({
      userId,
      jobId: params.data.id,
    });
    if (!job) {
      return c.json(await apiErrorResponse("aiJobNotFound"), {
        status: 404,
      });
    }

    return c.json(await toSummary(job, c.req.raw));
  })
  .delete("/:id", async (c) => {
    const userId = await authenticatedUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const params = pathParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const prepared = await prepareAiJobDeletionByUserId({
      userId,
      jobId: params.data.id,
    });
    if (prepared.outcome === "notFound") {
      return c.json(await apiErrorResponse("aiJobNotFound"), {
        status: 404,
      });
    }
    if (prepared.outcome === "active") {
      return c.json(await apiErrorResponse("aiJobIsActive"), {
        status: 409,
      });
    }

    // The job is hidden and scrubbed transactionally before touching R2. The
    // same transaction persists a cleanup intent, so scheduled reconciliation
    // can resume if this request or the R2 delete fails.
    if (prepared.outputFile) {
      await deleteAiOutputObject(prepared.outputFile.objectKey);
    }
    await finalizeAiJobDeletionByUserId({
      userId,
      jobId: params.data.id,
      outputFileId: prepared.outputFile?.id,
      outputObjectKey: prepared.outputFile?.objectKey,
    });

    return c.json({ deleted: true });
  });

export default app;

import {
  getAiJobByUserId,
  finalizeAiJobDeletionByUserId,
  listAiJobsByUserId,
  prepareAiJobDeletionByUserId,
  type AiJobHistoryCursor,
} from "@beutl/db";
import { Hono } from "hono";
import { z } from "zod";
import { deleteAiOutputObject, prepareGatewayVideoUsageForDeletion } from "../../ai/storage";
import { parseReplayableAiJobInput, sanitizeAiJobInputParams } from "../../ai/job-input";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import { getContentUrl } from "../../content-url";
import { publicAiJobError } from "../../ai/job-errors";
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

type AiJobRecord = NonNullable<
  Awaited<ReturnType<typeof getAiJobByUserId>>
>;

type AiJobSummary = {
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
    // A cursor that does not decode is the caller's input.
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
  return parseReplayableAiJobInput(job.kind, job.inputParams).success;
}

function sanitizedInputParams(job: AiJobRecord): Record<string, unknown> | null {
  return sanitizeAiJobInputParams(job.kind, job.inputParams);
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
    error: job.status === "failed" ? publicAiJobError(job.error) : null,
    canRetry: canRetry(job),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const app = new Hono()
  .get("/", async (c) => {
    const userId = await getUserId(c);
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
    const userId = await getUserId(c);
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
    const userId = await getUserId(c);
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
    // Keep the billing identity until actual cost arrives or its grace expires.
    const billing = await prepareGatewayVideoUsageForDeletion({
      userId,
      jobId: params.data.id,
    });
    if (billing === "pending") {
      return c.json(await apiErrorResponse("aiJobBillingInProgress"), { status: 409 });
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

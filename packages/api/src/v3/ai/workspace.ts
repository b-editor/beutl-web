import { Hono } from "hono";
import { z } from "zod";
import { listAiJobsByUserId, retrieveStorageFoldersByUserId } from "@beutl/db";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import { parseJsonWithBodyLimit } from "../../ai/upload-limits";
import { createStorageOperations } from "../../storage/files";

const saveSchema = z
  .object({ folderId: z.string().min(1).max(128).nullable(), saveKey: z.string().uuid() })
  .strict();

export default new Hono()
  .get("/source-videos", async (c) => {
    const userId = await getUserId(c);
    if (!userId) return c.json(await apiErrorResponse("authenticationIsRequired"), 401);
    const page = await listAiJobsByUserId({ userId, limit: 100 });
    return c.json({
      videos: page.jobs.flatMap((job) => {
        const duration = (job.inputParams as { durationSeconds?: unknown } | null)?.durationSeconds;
        if (
          job.kind !== "video" ||
          job.status !== "succeeded" ||
          !job.resultFileId ||
          !job.resultFile?.mimeType?.startsWith("video/") ||
          typeof duration !== "number" ||
          !Number.isFinite(duration) ||
          duration <= 0
        )
          return [];
        return [
          {
            jobId: job.id,
            fileName: job.resultFile.name,
            durationSeconds: Math.ceil(duration),
            createdAt: job.createdAt.toISOString(),
          },
        ];
      }),
    });
  })
  .get("/storage-folders", async (c) => {
    const userId = await getUserId(c);
    if (!userId) return c.json(await apiErrorResponse("authenticationIsRequired"), 401);
    const folders = await retrieveStorageFoldersByUserId({ userId });
    return c.json({ folders: folders.map(({ id, name, parentId }) => ({ id, name, parentId })) });
  })
  .post("/jobs/:id/storage", async (c) => {
    const userId = await getUserId(c);
    if (!userId) return c.json(await apiErrorResponse("authenticationIsRequired"), 401);
    const jobId = z.string().uuid().safeParse(c.req.param("id"));
    let input: ReturnType<typeof saveSchema.safeParse>;
    try {
      input = saveSchema.safeParse(await parseJsonWithBodyLimit(c.req));
    } catch {
      return c.json(await apiErrorResponse("invalidRequestBody"), 400);
    }
    if (!jobId.success || !input.success)
      return c.json(await apiErrorResponse("invalidRequestBody"), 400);
    const storage = createStorageOperations({
      waitUntil: (task) => {
        // Workers have an execution context; local Hono tests do not.
        try {
          c.executionCtx.waitUntil(task);
        } catch {
          /* Durable cleanup still owns uncertain writes. */
        }
      },
    });
    const outcome = await storage.copyAiResultToStorage({
      jobId: jobId.data,
      userId,
      ...input.data,
    });
    // These are storage outcomes, not new paid AI operations. Keep them typed
    // so the client can distinguish quota, missing media, and an unsettled save.
    return c.json(outcome);
  });

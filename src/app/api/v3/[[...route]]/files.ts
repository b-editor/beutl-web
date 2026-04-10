import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/db";
import { file } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { getContentUrl } from "@/lib/db/file";

async function findFile(id: string) {
  const db = await getDbAsync();
  return await db.query.file.findFirst({
    where: eq(file.id, id),
    columns: {
      id: true,
      name: true,
      mimeType: true,
      userId: true,
      size: true,
      sha256: true,
    },
  });
}

/* eslint-disable @typescript-eslint/no-unused-vars */
async function isAllowed(
  fileRecord: NonNullable<Awaited<ReturnType<typeof findFile>>>,
  userId: string | null,
) {
  // return userId === fileRecord.userId;
  // todo
  return true;
}

const app = new Hono().get("/:id", async (c) => {
  const id = c.req.param("id");
  const fileRecord = await findFile(id);

  if (!fileRecord) {
    return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });
  }

  const userId = await getUserId(c);
  if (!(await isAllowed(fileRecord, userId))) {
    return c.json(await apiErrorResponse("doNotHavePermissions"), {
      status: 403,
    });
  }

  return c.json({
    id: fileRecord.id,
    name: fileRecord.name,
    contentType: fileRecord.mimeType,
    downloadUrl: await getContentUrl(fileRecord.id),
    size: Number(fileRecord.size),
    sha256: fileRecord.sha256,
  });
});

export default app;

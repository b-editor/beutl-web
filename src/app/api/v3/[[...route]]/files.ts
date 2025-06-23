import "server-only";
import { Hono } from "hono";
import { drizzle } from "@/drizzle";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { getContentUrl } from "@/lib/db/file";
import { file } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

async function findFile(id: string) {
  const db = await drizzle();
  return await db
    .select({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      userId: file.userId,
      size: file.size,
      sha256: file.sha256,
    })
    .from(file)
    .where(eq(file.id, id))
    .limit(1)
    .then(r => r.at(0));
}

/* eslint-disable @typescript-eslint/no-unused-vars */
async function isAllowed(
  file: NonNullable<Awaited<ReturnType<typeof findFile>>>,
  userId: string | null,
) {
  // return userId === file.userId;
  // todo
  return true;
}

const app = new Hono().get("/:id", async (c) => {
  const id = c.req.param("id");
  const file = await findFile(id);

  if (!file) {
    return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });
  }

  const userId = await getUserId(c);
  if (!(await isAllowed(file, userId))) {
    return c.json(await apiErrorResponse("doNotHavePermissions"), {
      status: 403,
    });
  }

  return c.json({
    id: file.id,
    name: file.name,
    contentType: file.mimeType,
    downloadUrl: await getContentUrl(file.id),
    size: Number(file.size),
    sha256: file.sha256,
  });
});

export default app;

import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/prisma";
import { getUserId } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { getContentUrl } from "@/lib/db/file";

async function findFile(id: string) {
  const prisma = await getDbAsync();
  return await prisma.file.findFirst({
    where: {
      id: id,
    },
    select: {
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

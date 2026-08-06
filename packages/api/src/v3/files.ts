import { Hono } from "hono";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";
import { getContentUrl } from "../content-url";
import { findFileForApi } from "@beutl/db";

/* eslint-disable @typescript-eslint/no-unused-vars */
async function isAllowed(
  file: NonNullable<Awaited<ReturnType<typeof findFileForApi>>>,
  userId: string | null,
) {
  // return userId === file.userId;
  // todo
  return true;
}

const app = new Hono().get("/:id", async (c) => {
  const id = c.req.param("id");
  const file = await findFileForApi({ id });

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
    downloadUrl: await getContentUrl(file.id, c.req.raw),
    size: Number(file.size),
    sha256: file.sha256,
  });
});

export default app;

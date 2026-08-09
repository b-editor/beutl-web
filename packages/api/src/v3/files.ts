import { Hono } from "hono";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";
import { getContentUrl } from "../content-url";
import { resolveContentAccess } from "@beutl/core";
import { existsUserPaymentHistory, findFileForApi } from "@beutl/db";

const app = new Hono().get("/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Authorization");

  const id = c.req.param("id");
  const file = await findFileForApi({ id });

  if (!file) {
    return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });
  }

  const userId = await getUserId(c);
  const access = await resolveContentAccess({
    file,
    userId,
    hasPurchasedPackage: async (packageId) =>
      await existsUserPaymentHistory({
        userId: userId ?? undefined,
        packageId,
      }),
  });
  if (access.outcome === "denied") {
    return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });
  }
  if (access.outcome === "payment-required") {
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

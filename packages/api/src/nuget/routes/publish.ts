import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { packageNameFilter, reservePublishedReleaseIdentity, startRetryableTransaction } from "@beutl/db";
import { authenticateNuget } from "../tokens";
import { pushNugetPackage } from "../push";
import { refreshNugetPackageMetadata } from "../catalog";
import type { NugetEnv } from "../protocol";

type PublishEnv = NugetEnv & { Variables: { publisherId: string } };
const routes = new Hono<PublishEnv>();

const requirePushKey = createMiddleware<PublishEnv>(async (c, next) => {
  const auth = await authenticateNuget(c.req.raw.headers);
  if (!auth?.canPush) {
    if (c.req.method === "PUT") await c.req.raw.body?.cancel();
    return c.json({ message: "A push-enabled API key is required" }, auth ? 403 : 401);
  }
  c.set("publisherId", auth.userId);
  await next();
});

routes.put("/", requirePushKey, async (c) => {
  const result = await pushNugetPackage(c.req.raw, c.get("publisherId"), c.env?.execution);
  return result.kind === "created" ? c.body(null, 201) : c.json({ message: "Storage quota exceeded" }, 413);
});

routes.on(["DELETE", "POST"], "/:id/:version", requirePushKey, async (c) => {
  const result = await startRetryableTransaction(async (tx) => {
    const pkg = await tx.package.findFirst({
      where: { name: packageNameFilter(normalizeNugetId(c.req.param("id"))) },
      include: { Release: { include: { file: true } } },
    });
    if (!pkg) return 404;
    if (pkg.userId !== c.get("publisherId")) return 403;

    const version = normalizeNugetVersion(c.req.param("version"));
    const release = pkg.Release.find((candidate) => normalizeNugetVersion(candidate.version) === version);
    if (!release?.published || !release.fileId) return 404;
    await reservePublishedReleaseIdentity(tx, release);
    await tx.release.update({
      where: { id: release.id },
      data: { nugetListed: c.req.method === "POST", artifactLocked: true },
    });
    release.nugetListed = c.req.method === "POST";
    await refreshNugetPackageMetadata(tx, pkg);
    return c.req.method === "DELETE" ? 204 : 200;
  });
  return c.body(null, result);
});

export default routes;

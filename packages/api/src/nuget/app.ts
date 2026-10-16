import { Hono } from "hono";
import { cors } from "hono/cors";
import { InvalidNugetIdentityError } from "@beutl/core";
import { PackageIdentityReservedError, ReleaseArtifactLockedError, ReleaseIdentityConflictError } from "@beutl/db";
import { InvalidNugetPackageError } from "./archive";
import { NugetOwnershipError, NugetPackageUnpublishedError, NugetPushTooLargeError } from "./push";
import { nugetOrigin, type NugetEnv } from "./protocol";
import catalogRoutes from "./routes/catalog";
import contentRoutes from "./routes/content";
import publishRoutes from "./routes/publish";

export type { NugetEnv } from "./protocol";

const app = new Hono<NugetEnv>({ strict: false });

app.use("/v3/*", cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "OPTIONS"],
  allowHeaders: ["Authorization", "Range"],
  exposeHeaders: ["Content-Length", "Content-Range"],
}));
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/", (c) => c.json({ service: "Beutl NuGet", index: `${nugetOrigin(c)}/v3/index.json` }));
app.route("/v3", catalogRoutes);
app.route("/v3", contentRoutes);
app.route("/api/v2/package", publishRoutes);

app.onError((error, c) => {
  if (error instanceof NugetPackageUnpublishedError) return c.json({ message: error.message }, 400);
  if (error instanceof PackageIdentityReservedError) return c.json({ message: error.message }, 409);
  if (error instanceof ReleaseIdentityConflictError || error instanceof ReleaseArtifactLockedError ||
      ("code" in error && error.code === "P2002")) {
    return c.json({ message: "This package version already exists or was previously published" }, 409);
  }
  if (error instanceof NugetOwnershipError) {
    return c.json({ message: "Package belongs to another account" }, 403);
  }
  if (error instanceof NugetPushTooLargeError) {
    return c.json({ message: "The maximum push size is 50 MiB" }, 413);
  }
  if (error instanceof InvalidNugetPackageError || error instanceof InvalidNugetIdentityError) {
    return c.json({ message: error.message }, 400);
  }
  console.error("NuGet request failed", error);
  return c.json({ message: "NuGet request failed" }, 500);
});

export default app;

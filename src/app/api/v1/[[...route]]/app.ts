import { apiErrorResponse } from "@/lib/api/error";
import { Hono } from "hono";
import SemVer from "semver";

// @deprecated Superseded by v3 GET /app/updates. Kept for old desktop builds
// that still poll this endpoint; once client telemetry confirms it is unused,
// remove it along with the BEUTL_LATEST_VERSION / BEUTL_REQUIRED_VERSION env vars.
const app = new Hono().get("/checkForUpdates/:version", async (c) => {
  const version = c.req.param("version");
  const latest = new SemVer.SemVer(process.env.BEUTL_LATEST_VERSION as string);
  const required = new SemVer.SemVer(
    process.env.BEUTL_REQUIRED_VERSION as string,
  );
  if (!SemVer.valid(version)) {
    return c.json(await apiErrorResponse("invalidVersionFormat"), {
      status: 400,
    });
  }

  const v = new SemVer.SemVer(version);
  return c.json({
    latest_version: process.env.BEUTL_LATEST_VERSION,
    url: "https://github.com/b-editor/beutl/releases/latest",
    is_latest: latest.compare(v) <= 0,
    must_latest: required.compare(v) > 0,
  });
});

export default app;

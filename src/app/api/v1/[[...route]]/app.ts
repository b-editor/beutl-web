import { apiErrorResponse } from "@/lib/api/error";
import { Hono } from "hono";
import SemVer from "semver";

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

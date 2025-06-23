import { apiErrorResponse } from "@/lib/api/error";
import { drizzle } from "@/drizzle";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import SemVer from "semver";
import { z } from "zod";
import { appReleaseAsset } from "@/drizzle/schema";
import { and, eq } from "drizzle-orm"

const searchQuerySchema = z.object({
  // zip, debian, installer, appのいずれか
  type: z.string().refine((value) => ["zip", "debian", "installer", "app"].includes(value)),
  // linux, osx, win
  os: z.string().refine((value) => ["linux", "osx", "win"].includes(value)),
  // x64, arm64
  arch: z.string().refine((value) => ["x64", "arm64"].includes(value)),
  standalone: z.string().refine((value) => ["true", "false"].includes(value)).transform((value) => value === "true"),
  prerelease: z.string().refine((value) => ["true", "false"].includes(value)).transform((value) => value === "true"),
});

const app = new Hono()
  .get("/updates/:version", zValidator("query", searchQuerySchema), async (c) => {
    const version = c.req.param("version");
    const semver = SemVer.parse(version);
    if (!semver) {
      return c.json(await apiErrorResponse("invalidRequestBody"), { status: 400 });
    }

    const {
      type,
      os,
      arch,
      standalone,
      prerelease,
    } = c.req.valid("query");

    const db = await drizzle();
    const versions = await db
      .select({
        version: appReleaseAsset.version,
      }).
      from(appReleaseAsset)
      .then((rows) => rows.map((row) => row.version))
    const latest = [...new Set(versions)]
      .map((v) => new SemVer.SemVer(v))
      .filter((v) => prerelease || v.prerelease.length === 0)
      .sort((a, b) => SemVer.compare(b, a))[0];

    if (!latest) {
      console.error("latest version not found");
      return c.json(await apiErrorResponse("unknown"), { status: 404 });
    }

    if (SemVer.compare(latest, semver) <= 0) {
      return c.json({
        latestVersion: latest.version,
        url: null,
        downloadUrl: null,
        isLatest: true,
        mustLatest: false,
      });
    }
    const asset = await db
      .select()
      .from(appReleaseAsset)
      .where(
        and(
          eq(appReleaseAsset.version, latest.version),
          eq(appReleaseAsset.type, type),
          eq(appReleaseAsset.os, os),
          eq(appReleaseAsset.arch, arch),
          eq(appReleaseAsset.standalone, standalone),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0));

    if (!asset) {
      console.error("asset not found");
      return c.json(apiErrorResponse("assetNotFound"), { status: 404 });
    }

    return c.json({
      latestVersion: latest.version,
      url: `https://github.com/b-editor/beutl/releases/tag/v${latest.version}`,
      downloadUrl: asset.url,
      isLatest: false,
      mustLatest: asset.minVersion ? SemVer.compare(semver, new SemVer.SemVer(asset.minVersion)) < 0 : false,
    });
  });

export default app;

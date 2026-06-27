import { apiErrorResponse } from "@/lib/api/error";
import {
  findAppReleaseAsset,
  findAppReleaseAssetVersions,
} from "@/lib/db/app-release-asset";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import SemVer from "semver";
import { z } from "zod";

const searchQuerySchema = z.object({
  // zip, debian, installer, appのいずれか
  type: z.string().refine((value) => ["zip", "debian", "installer", "app"].includes(value)),
  // linux, osx, win
  os: z.string().refine((value) => ["linux", "osx", "win"].includes(value)),
  // x64, arm64
  arch: z.string().refine((value) => ["x64", "arm64"].includes(value)),
  standalone: z.string().refine((value) => ["true", "false"].includes(value)).transform((value) => value === "true"),
  prerelease: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
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
      prerelease: prereleaseQuery,
    } = c.req.valid("query");

    // NOTE: 一時的に prereleaseQuery を無視して、semver の prerelease があるかどうかで判定するようにする
    const includePrerelease = semver.prerelease.length > 0;
    // const includePrerelease = prereleaseQuery ?? semver.prerelease.length > 0;

    const versions = (await findAppReleaseAssetVersions({})).map((asset) => asset.version);
    const latest = [...new Set(versions)]
      .map((v) => new SemVer.SemVer(v))
      .filter((v) => includePrerelease || v.prerelease.length === 0)
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

    const asset = await findAppReleaseAsset({
      version: latest.version,
      type,
      os,
      arch,
      standalone,
    });

    if (!asset) {
      console.error("asset not found");
      return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });
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

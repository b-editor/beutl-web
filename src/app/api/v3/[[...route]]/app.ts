import { apiErrorResponse } from "@/lib/api/error";
import { prisma } from "@/prisma";
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
  prerelease: z.string().refine((value) => ["true", "false"].includes(value)).transform((value) => value === "true"),
});

const app = new Hono()
  .get("/updates/:version", zValidator("query", searchQuerySchema), async (c) => {
    const version = c.req.param("version");
    const semver = SemVer.parse(version);
    if (!semver) {
      return c.json(apiErrorResponse("invalidRequestBody"), { status: 400 });
    }

    const {
      type,
      os,
      arch,
      standalone,
      prerelease,
    } = c.req.valid("query");

    const versions = (await prisma.appReleaseAsset.findMany({
      select: {
        version: true,
      }
    })).map((asset) => asset.version);
    const latest = [...new Set(versions)]
      .map((v) => new SemVer.SemVer(v))
      .filter((v) => prerelease || v.prerelease.length === 0)
      .sort((a, b) => SemVer.compare(b, a))[0];

    if (!latest) {
      console.error("latest version not found");
      return c.json(apiErrorResponse("unknown"), { status: 404 });
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

    const asset = await prisma.appReleaseAsset.findFirst({
      where: {
        version: latest.version,
        type,
        os,
        arch,
        standalone,
      },
    });

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

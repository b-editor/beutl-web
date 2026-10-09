import "server-only";
import { unstable_cache } from "next/cache";
import SemVer from "semver";
import {
  findAppReleaseAssetsByVersion,
  findAppReleaseAssetVersions,
  type PrismaTransaction,
} from "@beutl/db";
import { withOwnPrismaClient } from "@/prisma";
import { toAppDownloads, type AppDownload } from "./app-download";

export type LatestAppRelease = {
  version: string;
  downloads: AppDownload[];
};

/*
  The newest registered version, previews included. The release workflow
  registers only what GitHub publishes as a full release, and the Beutl 2
  previews are published that way, so this is the release GitHub marks Latest.
*/
async function findLatestAppRelease(
  prisma: PrismaTransaction,
): Promise<LatestAppRelease | null> {
  const version = (await findAppReleaseAssetVersions({ prisma }))
    .map((asset) => asset.version)
    .filter((candidate) => SemVer.valid(candidate) !== null)
    .sort(SemVer.rcompare)[0];
  if (version === undefined) {
    return null;
  }

  const downloads = toAppDownloads(
    await findAppReleaseAssetsByVersion({ version, prisma }),
  );
  return downloads.length > 0 ? { version, downloads } : null;
}

/*
  Cached like the landing packages, and for the same reasons: the page is
  dynamic and the catalog changes once per release. The window is shorter so a
  new release reaches the front door soon after the workflow registers it; an
  entry that is still stale points at the previous release, whose files remain.
*/
const cachedLatestAppRelease = unstable_cache(
  () => withOwnPrismaClient((prisma) => findLatestAppRelease(prisma)),
  ["landing-latest-app-release"],
  { revalidate: 600 },
);

/*
  A failure yields null rather than an error: the landing page then links to
  the GitHub releases page, as it did before it offered files of its own.
*/
export async function retrieveLatestAppReleaseForLanding(): Promise<LatestAppRelease | null> {
  try {
    return await cachedLatestAppRelease();
  } catch (error) {
    console.error(
      "[landing] could not load the app release; linking to GitHub instead:",
      error,
    );
    return null;
  }
}

import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithDbProvider } from "@beutl/db";
import { runWithR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { resolveStorageBucket } from "@beutl/api/storage/bucket-from-env";
import { classifyNugetReleases } from "@beutl/api/nuget/catalog";

export async function backfillMetadata(checkOnly = false) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const where = { published: true, fileId: { not: null } };
  try {
    if (!checkOnly) {
      // This Node command runs outside Worker request limits. R2 can be read
      // through its S3 endpoint using the existing BEUTL_S3_* configuration.
      const bucket = resolveStorageBucket({});
      await runWithDbProvider(async () => db, () => runWithR2BucketProvider(() => bucket,
        () => classifyNugetReleases(where, true)));
    }
    const pending = await db.release.count({ where: { ...where,
      nugetMetadataInvalid: false, nugetMetadata: { equals: Prisma.AnyNull } } });
    const invalid = await db.release.count({ where: { ...where, nugetMetadataInvalid: true } });
    console.log(`NuGet metadata: ${pending} pending, ${invalid} invalid archives excluded`);
    if (pending) throw new Error("NuGet metadata backfill is incomplete; fix storage/cache errors and rerun before cutover");
  } finally { await db.$disconnect(); }
}

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import { after } from "next/server";
import { cache } from "react";

// Register a lazy OpenNext factory without reusing request-bound I/O across
// Worker invocations. The React cache below deduplicates Server Component calls.
const createPrismaClient = async () => {
  const { env } = await getCloudflareContext({ async: true });

  if (!env.BEUTL_DATABASE_HYPERDRIVE) {
    throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
  }

  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
  if (!connectionString) {
    throw new Error("Hyperdrive connection string not available");
  }

  const adapter = new PrismaPg({ connectionString, max: 5, maxUses: 1 });
  const prisma = new PrismaClient({ adapter });
  after(() => prisma.$disconnect());
  return prisma;
};

// OpenNext recommends React cache for sharing one Prisma client throughout a
// Server Component render. Calls outside that render create their own client.
const getPrismaClient = cache(createPrismaClient);

setDbProvider(getPrismaClient);

// AI 出力の保存先 (R2) を @beutl/api のストレージ層に登録する。
// getCloudflareContext はリクエストコンテキストでのみ利用可能なため遅延実行する。
setR2BucketProvider(() => {
  const { env } = getCloudflareContext();
  if (!env.BEUTL_R2_BUCKET) {
    throw new Error("BEUTL_R2_BUCKET binding not found");
  }
  return env.BEUTL_R2_BUCKET;
});

export type { PrismaClient };

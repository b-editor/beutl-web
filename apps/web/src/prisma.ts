import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "cloudflare:workers";
import { runWithDbProvider, setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { resolveStorageBucket } from "@beutl/api/storage/bucket-from-env";
import { after } from "next/server";
import { cache } from "react";

function newPrismaClient(): PrismaClient {
  if (!env.BEUTL_DATABASE_HYPERDRIVE) {
    throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
  }

  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
  if (!connectionString) {
    throw new Error("Hyperdrive connection string not available");
  }

  const adapter = new PrismaPg({ connectionString, max: 5, maxUses: 1 });
  return new PrismaClient({ adapter });
}

// Register a lazy factory without reusing request-bound I/O across Worker
// invocations. The React cache below deduplicates Server Component calls.
const createPrismaClient = async () => {
  const prisma = newPrismaClient();
  after(() => prisma.$disconnect());
  return prisma;
};

// React cache shares one Prisma client throughout a Server Component render.
// Calls outside that render create their own client.
const getPrismaClient = cache(createPrismaClient);

setDbProvider(getPrismaClient);

/**
 * Run work on a client of its own and release it as soon as the work settles.
 * For code inside unstable_cache(), where vinext forbids after(): the shared
 * client would otherwise be created there and never released.
 */
export async function withScopedPrismaClient<T>(work: () => Promise<T>): Promise<T> {
  const prisma = newPrismaClient();
  try {
    return await runWithDbProvider(async () => prisma, work);
  } finally {
    await prisma.$disconnect();
  }
}

// ファイルと AI 出力の保存先 (R2 か S3 互換ストレージ) を @beutl/api の
// ストレージ層に登録する。
setR2BucketProvider(() => resolveStorageBucket(env));

export type { PrismaClient };

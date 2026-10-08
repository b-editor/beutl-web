import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { resolveStorageBucket } from "@beutl/api/storage/bucket-from-env";
import { after } from "next/server";
import { cache } from "react";

async function connectPrismaClient() {
  const { env } = await getCloudflareContext({ async: true });

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

// Register a lazy OpenNext factory without reusing request-bound I/O across
// Worker invocations. The React cache below deduplicates Server Component calls.
const createPrismaClient = async () => {
  const prisma = await connectPrismaClient();
  after(() => prisma.$disconnect());
  return prisma;
};

/**
 * A client of its own for work that can outlive the response, released when
 * that work settles. A stale `unstable_cache` entry is recomputed in the
 * background after the page has answered; on the request client, `after()`
 * would end the pool between that work's queries.
 */
export async function withOwnPrismaClient<T>(
  work: (prisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = await connectPrismaClient();
  try {
    return await work(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// OpenNext recommends React cache for sharing one Prisma client throughout a
// Server Component render. Calls outside that render create their own client.
const getPrismaClient = cache(createPrismaClient);

setDbProvider(getPrismaClient);

// ファイルと AI 出力の保存先 (R2 か S3 互換ストレージ) を @beutl/api の
// ストレージ層に登録する。getCloudflareContext はリクエストコンテキストでのみ
// 利用可能なため遅延実行する。
setR2BucketProvider(() => resolveStorageBucket(getCloudflareContext().env));

export type { PrismaClient };

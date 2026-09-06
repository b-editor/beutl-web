import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { hasDbProviderScope, setDbProvider } from "@beutl/db";
import { after } from "next/server";
import { cache } from "react";

// OpenNext (Cloudflare Workers) 用の PrismaClient 生成を @beutl/db に登録する。
// Hyperdrive の per-request 接続モデル (maxUses:1) に合わせ、毎リクエスト新規生成する。
const createPrismaClient = async () => {
  const { env } = await getCloudflareContext({ async: true });

  if (!env.BEUTL_DATABASE_HYPERDRIVE) {
    throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
  }

  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
  if (!connectionString) {
    throw new Error("Hyperdrive connection string not available");
  }

  const adapter = new PrismaPg({ connectionString, maxUses: 1 });
  const prisma = new PrismaClient({ adapter });
  if (!hasDbProviderScope()) {
    after(() => prisma.$disconnect());
  }
  return prisma;
};

// React handles RSC renders; the production Worker wrapper also covers Route
// Handlers and Server Actions.
const getPrismaClient = cache(createPrismaClient);

setDbProvider(getPrismaClient);

export type { PrismaClient };

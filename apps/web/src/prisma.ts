import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { setDbProvider } from "@beutl/db";

// OpenNext (Cloudflare Workers) 用の PrismaClient 生成を @beutl/db に登録する。
// Hyperdrive の per-request 接続モデル (maxUses:1) に合わせ、毎リクエスト新規生成する。
// NOTE: モジュールロード時に即座に PrismaClient を生成しない (Cloudflare の
// getCloudflareContext はリクエストコンテキストでのみ利用可能なため遅延実行する)。
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
  return new PrismaClient({ adapter });
};

setDbProvider(createPrismaClient);

export type { PrismaClient };

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";

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

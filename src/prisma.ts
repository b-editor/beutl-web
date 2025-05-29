import { getCloudflareContext } from "@opennextjs/cloudflare";
import { PrismaClient } from "@prisma/client";

export async function prisma() {
  return new PrismaClient({
    datasourceUrl: (await getCloudflareContext({ async: true })).env.BEUTL_DATABASE_HYPERDRIVE.connectionString || process.env.DATABASE_URL,
  });
}
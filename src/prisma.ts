import { getCloudflareContext } from "@opennextjs/cloudflare";
import { PrismaClient } from "@prisma/client";

import { PrismaPg } from '@prisma/adapter-pg'

export async function prisma() {
  const connectionString = (await getCloudflareContext({ async: true })).env.BEUTL_DATABASE_HYPERDRIVE.connectionString || process.env.DATABASE_URL;
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: adapter as any
  });
}
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithDbProvider } from "@beutl/db";
import { runWithR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { resolveStorageBucket } from "@beutl/api/storage/bucket-from-env";
import { reconcileAiJobs } from "@beutl/api/ai/reconcile-jobs";

type ScheduledAiEnvironment = {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: string };
} & Record<string, unknown>;

/** Run the existing reconciler with per-invocation bindings and dispose its DB pools. */
export async function reconcileWebAiJobs(
  env: ScheduledAiEnvironment,
  now: Date,
): Promise<Awaited<ReturnType<typeof reconcileAiJobs>>> {
  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");

  const clients: PrismaClient[] = [];
  try {
    return await runWithDbProvider(async () => {
      const client = new PrismaClient({
        adapter: new PrismaPg({ connectionString, maxUses: 1 }),
      });
      clients.push(client);
      return client;
    }, () => runWithR2BucketProvider(
      () => resolveStorageBucket(env),
      () => reconcileAiJobs(now),
    ));
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
}

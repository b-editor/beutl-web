import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithDbProvider } from "@beutl/db";
import { runWithR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { resolveStorageBucket } from "@beutl/api/storage/bucket-from-env";
import { resolveWorkerSecrets, type WorkerSecretBindings } from "@beutl/api/worker-secrets";
import app from "@beutl/api/nuget/app";

type Env = Parameters<typeof resolveStorageBucket>[0] & {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: string };
  NUGET_PUBLIC_ORIGIN?: string;
  NUGET_DOWNLOAD_SECRET: string;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
};
type Execution = { waitUntil(promise: Promise<unknown>): void };

export default {
  async fetch(request: Request, bindings: WorkerSecretBindings<Env>, ctx: Execution) {
    const env = await resolveWorkerSecrets<Env>(bindings);
    const connectionString = env.BEUTL_DATABASE_HYPERDRIVE?.connectionString;
    if (!connectionString || !env.NUGET_DOWNLOAD_SECRET) throw new Error("NuGet Worker bindings are missing");
    for (const key of ["NUGET_DOWNLOAD_SECRET", "JWT_SECRET", "JWT_ISSUER", "JWT_AUDIENCE"] as const) {
      if (env[key]) process.env[key] = env[key];
    }
    const bucket = resolveStorageBucket(env);
    const withDatabase = async <T>(work: () => Promise<T>) => {
      const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, maxUses: 1 }) });
      try { return await runWithDbProvider(async () => db, work); }
      finally { await db.$disconnect(); }
    };
    return runWithR2BucketProvider(() => bucket, () => withDatabase(async () => app.fetch(request, {
      NUGET_PUBLIC_ORIGIN: env.NUGET_PUBLIC_ORIGIN,
      execution: { waitUntil: (task) => ctx.waitUntil(task), runWithBackgroundDb: (work) => withDatabase(work) },
    })));
  },
};

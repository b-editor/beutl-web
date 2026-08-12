// @ts-ignore The OpenNext worker is generated before Wrangler bundles this file.
import openNextHandler from "./.open-next/worker.js";
import { scheduleStorageCleanupBatch } from "./src/lib/storage-cleanup-consumer";
import { configurePrismaProvider } from "./src/prisma";

type ScheduledControllerLike = Readonly<{
  scheduledTime: number;
  cron: string;
}>;

type WorkerExecutionContext = Readonly<{
  waitUntil(promise: Promise<unknown>): void;
}>;

export default {
  fetch: openNextHandler.fetch,

  scheduled(
    controller: ScheduledControllerLike,
    env: CloudflareEnv,
    context: WorkerExecutionContext,
  ) {
    configurePrismaProvider(env);
    scheduleStorageCleanupBatch({
      context,
      bucket: env.BEUTL_R2_BUCKET,
      scheduledTime: controller.scheduledTime,
      cron: controller.cron,
    });
  },
};

import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runWithDbProvider } from "@beutl/db";
import { createStorageOperations } from "@beutl/api/storage/files";
export type { StorageWriteSource, AiResultStorageCopyOutcome } from "@beutl/api/storage/files";

function operations() {
  return createStorageOperations({
    waitUntil: (task) => getCloudflareContext().ctx?.waitUntil?.(task),
    runWithBackgroundDb: async (work) => {
      const { withOwnPrismaClient } = await import("@/prisma");
      return await withOwnPrismaClient((prisma) =>
        runWithDbProvider(async () => prisma, work),
      );
    },
  });
}

export async function deleteStorageFile(
  ...args: Parameters<ReturnType<typeof createStorageOperations>["deleteStorageFile"]>
) {
  return await operations().deleteStorageFile(...args);
}

export async function calcTotalFileSize(
  ...args: Parameters<ReturnType<typeof createStorageOperations>["calcTotalFileSize"]>
) {
  return await operations().calcTotalFileSize(...args);
}

export async function createStorageFile(
  ...args: Parameters<ReturnType<typeof createStorageOperations>["createStorageFile"]>
) {
  return await operations().createStorageFile(...args);
}

export async function createDedicatedStorageFile(
  ...args: Parameters<ReturnType<typeof createStorageOperations>["createDedicatedStorageFile"]>
) {
  return await operations().createDedicatedStorageFile(...args);
}

export async function copyAiResultToStorage(
  ...args: Parameters<ReturnType<typeof createStorageOperations>["copyAiResultToStorage"]>
) {
  return await operations().copyAiResultToStorage(...args);
}

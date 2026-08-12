import { countDueStorageCleanups } from "@beutl/db";
import {
  drainStorageCleanup,
  storageCleanupFailureCodes,
  type StorageBucket,
  type StorageCleanupDrainResult,
} from "./storage";

export const storageCleanupBatchSize = 25;
export const storageCleanupObservationEvent = "storage_cleanup.batch";
export const storageCleanupBatchFailureCode =
  "STORAGE_CLEANUP_BATCH_FAILED";

export type StorageCleanupBatchObservation = StorageCleanupDrainResult &
  Readonly<{
    event: typeof storageCleanupObservationEvent;
    scheduledTime: number;
    cron: string;
    backlog: number;
  }>;

type CleanupLogger = Readonly<{
  info(message: string): void;
  error(message: string): void;
}>;

type CleanupExecutionContext = Readonly<{
  waitUntil(promise: Promise<unknown>): void;
}>;

export async function runStorageCleanupBatch({
  bucket,
  scheduledTime,
  cron,
  limit = storageCleanupBatchSize,
  drain = drainStorageCleanup,
  countBacklog = countDueStorageCleanups,
}: {
  bucket: StorageBucket;
  scheduledTime: number;
  cron: string;
  limit?: number;
  drain?: typeof drainStorageCleanup;
  countBacklog?: typeof countDueStorageCleanups;
}): Promise<StorageCleanupBatchObservation> {
  const result = await drain({ bucket, limit });
  let backlog = 0;
  const failureCounts = { ...result.failureCounts };
  try {
    backlog = await countBacklog();
  } catch {
    failureCounts[storageCleanupFailureCodes.backlogCount]++;
  }
  return {
    event: storageCleanupObservationEvent,
    scheduledTime,
    cron,
    ...result,
    failureCounts,
    backlog,
  };
}

export async function observeStorageCleanupBatch({
  logger = console,
  ...options
}: Parameters<typeof runStorageCleanupBatch>[0] & {
  logger?: CleanupLogger;
}): Promise<StorageCleanupBatchObservation> {
  const observation = await runStorageCleanupBatch(options);
  const failureCount = Object.values(observation.failureCounts)
    .reduce((total, count) => total + count, 0);
  const message = JSON.stringify(observation);
  if (failureCount > 0) {
    logger.error(message);
    throw new Error(storageCleanupBatchFailureCode);
  }
  logger.info(message);
  return observation;
}

export function scheduleStorageCleanupBatch({
  context,
  ...options
}: Parameters<typeof observeStorageCleanupBatch>[0] & {
  context: CleanupExecutionContext;
}): void {
  context.waitUntil(observeStorageCleanupBatch(options));
}

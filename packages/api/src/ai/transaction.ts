import { startRetryableTransaction, type PrismaTransaction } from "@beutl/db";

// Reservation, output settlement, and refunds make several database round trips
// through Hyperdrive. Prisma's five-second default can expire mid-ledger update.
// Keep these atomic, database-only units bounded without changing unrelated
// transactions. Provider requests and object-store I/O stay outside the callback.
export const AI_JOB_TRANSACTION_TIMEOUT_MS = 30_000;

export async function startAiJobTransaction<T>(
  callback: (prisma: PrismaTransaction) => Promise<T>,
): Promise<T> {
  return await startRetryableTransaction(callback, {
    timeout: AI_JOB_TRANSACTION_TIMEOUT_MS,
  });
}

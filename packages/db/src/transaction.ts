import { getDb } from "./provider";
import type { PrismaClient } from "@prisma/client";

export type PrismaTransaction = Parameters<
  Parameters<typeof PrismaClient.prototype.$transaction>[0]
>[0];

const MAX_TRANSACTION_ATTEMPTS = 5;

function isRetryableWriteConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "P2034") {
    return true;
  }
  if (
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "kind" in error.cause &&
    error.cause.kind === "TransactionWriteConflict"
  ) {
    return true;
  }
  if (
    "meta" in error &&
    typeof error.meta === "object" &&
    error.meta !== null &&
    "driverAdapterError" in error.meta
  ) {
    return isRetryableWriteConflict(error.meta.driverAdapterError);
  }
  return false;
}

export const startTransaction = async <T>(
  callback: (tx: PrismaTransaction) => Promise<T>,
) => {
  const db = await getDb();
  return await db.$transaction(callback);
};

// The callback may be replayed and must contain only database operations that
// become safe to repeat when the failed transaction is rolled back.
export const startRetryableTransaction = async <T>(
  callback: (tx: PrismaTransaction) => Promise<T>,
) => {
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(callback);
    } catch (error) {
      if (
        attempt >= MAX_TRANSACTION_ATTEMPTS ||
        !isRetryableWriteConflict(error)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
};

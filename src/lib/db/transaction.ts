import { getDbAsync } from "@/db";
import type { DbTransaction } from "@/db/types";

export type { DbTransaction };

export const startTransaction = async <T>(
  callback: (tx: DbTransaction) => Promise<T>,
) => {
  const db = await getDbAsync();
  return db.transaction(callback);
};

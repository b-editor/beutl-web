import { getDb } from "./provider";
import type { PrismaClient } from "@prisma/client";

export type PrismaTransaction = Parameters<
  Parameters<typeof PrismaClient.prototype.$transaction>[0]
>[0];

export const startTransaction = async <T>(callback: (tx: PrismaTransaction) => Promise<T>) => {
  const db = await getDb();
  return db.$transaction(callback);
};

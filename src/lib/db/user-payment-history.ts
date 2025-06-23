import "server-only";
import { drizzle } from "@/drizzle";
import type { Transaction } from "./transaction";
import { userPaymentHistory } from "@/drizzle/schema";
import { and, desc, eq } from "drizzle-orm";

export async function getUserPaymentHistory({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.select()
    .from(userPaymentHistory)
    .where(eq(userPaymentHistory.userId, userId))
    .orderBy(desc(userPaymentHistory.createdAt));
}

export async function existsUserPaymentHistory({
  userId,
  packageId,
  transaction,
}: {
  userId?: string;
  packageId: string;
  transaction?: Transaction;
}) {
  if (!userId) return false;
  const db = transaction || await drizzle();
  return await db.select({
    id: userPaymentHistory.id,
  })
    .from(userPaymentHistory)
    .where(and(eq(userPaymentHistory.userId, userId), eq(userPaymentHistory.packageId, packageId)))
    .limit(1)
    .then((rows) => rows.length > 0);
}

export async function createUserPaymentHistory({
  userId,
  packageId,
  paymentIntentId,
  transaction,
}: {
  userId: string;
  packageId: string;
  paymentIntentId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.insert(userPaymentHistory)
    .values({
      userId: userId,
      packageId: packageId,
      paymentId: paymentIntentId,
    });
}

import "server-only";
import { getDbAsync } from "@/db";
import { userPaymentHistory } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { DbTransaction } from "./transaction";

export async function getUserPaymentHistory({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db.query.userPaymentHistory.findMany({
    where: eq(userPaymentHistory.userId, userId),
    orderBy: desc(userPaymentHistory.createdAt),
  });
}

export async function existsUserPaymentHistory({
  userId,
  packageId,
  tx,
}: {
  userId?: string;
  packageId: string;
  tx?: DbTransaction;
}) {
  if (!userId) return false;
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ id: userPaymentHistory.id })
    .from(userPaymentHistory)
    .where(
      and(
        eq(userPaymentHistory.userId, userId),
        eq(userPaymentHistory.packageId, packageId),
      ),
    )
    .limit(1);
  return result.length > 0;
}

export async function createUserPaymentHistory({
  userId,
  packageId,
  paymentIntentId,
  tx,
}: {
  userId: string;
  packageId: string;
  paymentIntentId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db.insert(userPaymentHistory).values({
    userId,
    packageId,
    paymentId: paymentIntentId,
  });
}

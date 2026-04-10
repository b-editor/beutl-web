import "server-only";
import { getDbAsync } from "@/db";
import { user } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "./transaction";

export async function existsUserByEmail({
  email,
  tx,
}: {
  email: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return result.length > 0;
}

export async function existsUserById({
  id,
  tx,
}: {
  id: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  return result.length > 0;
}

export async function updateUserEmail({
  userId,
  email,
  tx,
}: {
  userId: string;
  email: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db.update(user).set({ email }).where(eq(user.id, userId));
}

export async function findEmailByUserId({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return result[0] ?? null;
}

export async function getEmailVerifiedByUserId({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return result[0]?.emailVerified;
}

export async function deleteUserById({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db.delete(user).where(eq(user.id, userId));
}

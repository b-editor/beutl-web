import "server-only";
import { drizzle } from "@/drizzle";
import type { Transaction } from "./transaction";
import { user } from "@/drizzle/schema";
import { count, eq } from "drizzle-orm";

export async function existsUserByEmail({
  email,
  transaction,
}: {
  email: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.select({
    cnt: count(),
  })
    .from(user)
    .where(eq(user.email, email))
    .then((rows) => rows[0].cnt > 0);
}

export async function existsUserById({
  id,
  transaction,
}: {
  id: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return db.select({
    cnt: count(),
  })
    .from(user)
    .where(eq(user.id, id))
    .then((rows) => rows[0].cnt > 0);
}

export async function updateUserEmail({
  userId,
  email,
  transaction,
}: {
  userId: string;
  email: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.update(user)
    .set({
      email: email,
    })
    .where(eq(user.id, userId));
}

export async function findEmailByUserId({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return db.select({
    email: user.email,
  })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .then((rows) => rows.at(0));
}

export async function getEmailVerifiedByUserId({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.select({
    emailVerified: user.emailVerified,
  })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .then((rows) => rows.at(0)?.emailVerified);
}

export async function deleteUserById({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.delete(user)
    .where(eq(user.id, userId));
}

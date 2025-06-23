import "server-only";
import { drizzle } from "@/drizzle";
import type { Transaction } from "./transaction";
import { authenticator } from "@/drizzle/schema";
import { and, eq } from "drizzle-orm";

export async function updateAuthenticatorUsedAt({
  credentialID,
  usedAt,
  transaction,
}: {
  credentialID: string;
  usedAt: Date;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.update(authenticator)
    .set({
      usedAt: usedAt,
    })
    .where(eq(authenticator.credentialId, credentialID));
}

export async function deleteAuthenticator({
  credentialID,
  userId,
  transaction,
}: {
  credentialID: string;
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.delete(authenticator)
    .where(and(
      eq(authenticator.userId, userId),
      eq(authenticator.credentialId, credentialID),
    ));
}

export async function updateAuthenticatorName({
  credentialID,
  userId,
  name,
  transaction,
}: {
  credentialID: string;
  userId: string;
  name: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.update(authenticator)
    .set({
      name,
    })
    .where(and(
      eq(authenticator.userId, userId),
      eq(authenticator.credentialId, credentialID),
    ));
}

export async function findAuthenticatorByAccountId({
  providerAccountId,
  transaction,
}: {
  providerAccountId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.select().from(authenticator)
    .where(eq(authenticator.providerAccountId, providerAccountId))
    .limit(1)
    .then((rows) => rows.at(0));
}

import "server-only";
import { drizzle } from "@/drizzle";
import type { Transaction } from "./transaction";
import { account } from "@/drizzle/schema";
import { and, eq } from "drizzle-orm";

export async function retrieveAccounts({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.select({
    providerAccountId: account.providerAccountId,
    provider: account.provider,
  })
    .from(account)
    .where(eq(account.userId, userId));
}

export async function retrieveAccountsWithIdToken({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.select({
    providerAccountId: account.providerAccountId,
    provider: account.provider,
    id_token: account.idToken,
  })
    .from(account)
    .where(eq(account.userId, userId));
}

export async function deleteAccount({
  providerAccountId,
  provider,
  transaction,
}: {
  providerAccountId: string;
  provider: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  await db.delete(account).where(
    and(
      eq(account.providerAccountId, providerAccountId),
      eq(account.provider, provider)
    )
  );
}

import "server-only";
import { getDbAsync } from "@/db";
import { account } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "./transaction";

export async function retrieveAccounts({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db
    .select({
      accountId: account.accountId,
      providerId: account.providerId,
    })
    .from(account)
    .where(eq(account.userId, userId));
}

export async function retrieveAccountsWithIdToken({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db
    .select({
      accountId: account.accountId,
      providerId: account.providerId,
      idToken: account.idToken,
    })
    .from(account)
    .where(eq(account.userId, userId));
}

export async function deleteAccount({
  accountId: accountIdValue,
  providerId,
  tx,
}: {
  accountId: string;
  providerId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db
    .delete(account)
    .where(
      and(
        eq(account.accountId, accountIdValue),
        eq(account.providerId, providerId),
      ),
    );
}

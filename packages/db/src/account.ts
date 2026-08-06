import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// Better Auth uses accountId and providerId instead of providerAccountId and provider
export async function retrieveAccounts({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.account.findMany({
    where: {
      userId: userId,
    },
    select: {
      accountId: true,
      providerId: true,
    },
  });
}

export async function retrieveAccountsWithIdToken({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.account.findMany({
    where: {
      userId: userId,
    },
    select: {
      accountId: true,
      providerId: true,
      idToken: true,
    },
  });
}

export async function deleteAccount({
  accountId,
  providerId,
  prisma,
}: {
  accountId: string;
  providerId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  await db.account.delete({
    where: {
      providerId_accountId: {
        accountId,
        providerId,
      },
    }
  });
}

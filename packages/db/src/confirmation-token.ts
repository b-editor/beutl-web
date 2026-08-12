import { getDb } from "./provider";
import type { ConfirmationTokenPurpose } from "@prisma/client";
import type { PrismaTransaction } from "./transaction";

type ConfirmationTokenData = {
  token: string;
  identifier: string;
  userId: string;
  expires: Date;
  purpose: ConfirmationTokenPurpose;
};

type ConfirmationTokenIdentifierTokenWhere = {
  identifier: string;
  token: string;
};

type ConfirmationTokenUserPurposeWhere = {
  userId: string;
  purpose: ConfirmationTokenPurpose;
};

export async function createConfirmationToken(
  data: ConfirmationTokenData,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
  return db.confirmationToken.create({
    data,
  });
}

export async function countConfirmationTokens(
  where: ConfirmationTokenIdentifierTokenWhere,
  prisma?: PrismaTransaction,
): Promise<number> {
  const db = prisma ?? await getDb();
  return db.confirmationToken.count({
    where,
  });
}

export async function deleteConfirmationTokenByIdentifierToken(
  where: ConfirmationTokenIdentifierTokenWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
  return db.confirmationToken.delete({
    where: {
      identifier_token: where,
    },
    select: {
      identifier: true,
      expires: true,
      userId: true,
      purpose: true,
    },
  });
}

export async function findConfirmationTokenByIdentifierToken(
  where: ConfirmationTokenIdentifierTokenWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
  return await db.confirmationToken.findUnique({
    where: {
      identifier_token: where,
    },
    select: {
      identifier: true,
      expires: true,
      userId: true,
      purpose: true,
    },
  });
}

export async function consumeConfirmationTokenByIdentifierToken({
  identifier,
  token,
  purpose,
  userId,
  now,
  prisma,
}: ConfirmationTokenIdentifierTokenWhere & {
  purpose: ConfirmationTokenPurpose;
  userId: string;
  now: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const consumed = await db.confirmationToken.deleteMany({
    where: {
      identifier,
      token,
      purpose,
      userId,
      expires: { gt: now },
    },
  });
  return consumed.count === 1;
}

export async function deleteManyConfirmationTokens(
  where: ConfirmationTokenUserPurposeWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
  return db.confirmationToken.deleteMany({
    where,
  });
}

export async function findManyConfirmationTokens(
  where: ConfirmationTokenUserPurposeWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
  return db.confirmationToken.findMany({
    where,
  });
}

import "server-only";
import { getDbAsync } from "@/prisma";
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
  const db = prisma ?? await getDbAsync();
  return db.confirmationToken.create({
    data,
  });
}

export async function countConfirmationTokens(
  where: ConfirmationTokenIdentifierTokenWhere,
  prisma?: PrismaTransaction,
): Promise<number> {
  const db = prisma ?? await getDbAsync();
  return db.confirmationToken.count({
    where,
  });
}

export async function deleteConfirmationTokenByIdentifierToken(
  where: ConfirmationTokenIdentifierTokenWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDbAsync();
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

export async function deleteManyConfirmationTokens(
  where: ConfirmationTokenUserPurposeWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDbAsync();
  return db.confirmationToken.deleteMany({
    where,
  });
}

export async function findManyConfirmationTokens(
  where: ConfirmationTokenUserPurposeWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDbAsync();
  return db.confirmationToken.findMany({
    where,
  });
}

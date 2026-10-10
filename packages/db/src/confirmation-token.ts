import { getDb } from "./provider";
import type { ConfirmationTokenPurpose } from "@prisma/client";
import type { PrismaTransaction } from "./transaction";
import { startRetryableTransaction } from "./transaction";

type ConfirmationTokenData = {
  token: string;
  identifier: string;
  userId: string;
  expires: Date;
  purpose: ConfirmationTokenPurpose;
  sessionId?: string;
  sourceEmail?: string;
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
  if (data.purpose === "ACCOUNT_DELETE")
    return (prisma ?? (await getDb())).confirmationToken.create({ data });
  const create = async (db: PrismaTransaction) => {
    if (data.purpose === "EMAIL_UPDATE" || data.purpose === "EMAIL_UPDATE_APPROVAL") {
      if (
        !data.sessionId ||
        !data.sourceEmail ||
        !(await db.session.findFirst({
          where: {
            id: data.sessionId,
            userId: data.userId,
            expiresAt: { gt: new Date() },
            user: { email: data.sourceEmail },
          },
          select: { id: true },
        }))
      )
        throw new Error("Email change session is no longer valid");
    }
    return db.confirmationToken.create({ data });
  };
  return prisma
    ? create(prisma)
    : startRetryableTransaction(create, { isolationLevel: "Serializable" });
}

export async function findConfirmationTokenByIdentifierToken(
  where: ConfirmationTokenIdentifierTokenWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? (await getDb());
  return await db.confirmationToken.findUnique({
    where: {
      identifier_token: where,
    },
    select: {
      identifier: true,
      expires: true,
      userId: true,
      purpose: true,
      sessionId: true,
      sourceEmail: true,
      session: { select: { userId: true, expiresAt: true } },
      user: { select: { email: true } },
    },
  });
}

export async function consumeConfirmationTokenByIdentifierToken({
  identifier,
  token,
  purpose,
  userId,
  now,
  sessionId,
  sourceEmail,
  authorizedSessionId,
  prisma,
}: ConfirmationTokenIdentifierTokenWhere & {
  purpose: ConfirmationTokenPurpose;
  userId: string;
  now: Date;
  sessionId?: string;
  sourceEmail?: string;
  authorizedSessionId?: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const emailChange = purpose === "EMAIL_UPDATE" || purpose === "EMAIL_UPDATE_APPROVAL";
  if (
    emailChange &&
    (!sessionId ||
      !sourceEmail ||
      !authorizedSessionId ||
      !(await db.session.findFirst({
        where: { id: authorizedSessionId, userId, expiresAt: { gt: now } },
        select: { id: true },
      })))
  )
    return false;
  const consumed = await db.confirmationToken.deleteMany({
    where: {
      identifier,
      token,
      purpose,
      userId,
      expires: { gt: now },
      ...(emailChange
        ? {
            sessionId,
            sourceEmail,
            session: { is: { userId, expiresAt: { gt: now } } },
            user: { is: { email: sourceEmail } },
          }
        : {}),
    },
  });
  return consumed.count === 1;
}

export async function deleteManyConfirmationTokens(
  where: ConfirmationTokenUserPurposeWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? (await getDb());
  return db.confirmationToken.deleteMany({
    where,
  });
}

export async function findManyConfirmationTokens(
  where: ConfirmationTokenUserPurposeWhere,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? (await getDb());
  return db.confirmationToken.findMany({
    where,
  });
}

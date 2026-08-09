import { getDb } from "./provider";
import { startTransaction, type PrismaTransaction } from "./transaction";

export async function createSession({
  token,
  expiresAt,
  userId,
  refreshTokenFamilyId,
  prisma,
}: {
  token: string;
  expiresAt: Date;
  userId: string;
  refreshTokenFamilyId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.session.create({
    data: {
      token,
      expiresAt,
      userId,
      refreshTokenFamilyId,
    },
  });
}

export async function deleteSessionsByToken({
  token,
  prisma,
}: {
  token: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.session.deleteMany({
    where: {
      token,
    },
  });
}

export const REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS = 10_000;

type RefreshSession = {
  token: string;
  userId: string;
  expiresAt: Date;
  refreshTokenFamilyId: string | null;
  refreshTokenConsumedAt: Date | null;
  refreshTokenReplacedByToken: string | null;
  refreshTokenRevokedAt: Date | null;
};

export type RotateSessionResult = {
  userId: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

// This capability must come from a successfully decrypted native refresh
// request. General session callers must omit it so null-family browser sessions
// remain outside refresh-token rotation.
export type LegacyNativeSessionAdoption = {
  familyId: string;
};

async function findRefreshSession(
  db: PrismaTransaction,
  token: string,
): Promise<RefreshSession | null> {
  return await db.session.findUnique({
    where: { token },
    select: {
      token: true,
      userId: true,
      expiresAt: true,
      refreshTokenFamilyId: true,
      refreshTokenConsumedAt: true,
      refreshTokenReplacedByToken: true,
      refreshTokenRevokedAt: true,
    },
  });
}

async function revokeRefreshTokenFamily(
  db: PrismaTransaction,
  familyId: string,
  now: Date,
) {
  await db.session.updateMany({
    where: {
      refreshTokenFamilyId: familyId,
      refreshTokenRevokedAt: null,
    },
    data: {
      refreshTokenRevokedAt: now,
    },
  });
}

async function reuseReplacementOrRevokeFamily(
  db: PrismaTransaction,
  session: RefreshSession,
  now: Date,
): Promise<RotateSessionResult | null> {
  const familyId = session.refreshTokenFamilyId;
  const consumedAt = session.refreshTokenConsumedAt;
  if (!familyId || !consumedAt) {
    return null;
  }
  const graceExpiresAt =
    consumedAt.getTime() + REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS;
  if (
    now.getTime() <= graceExpiresAt &&
    session.refreshTokenReplacedByToken
  ) {
    const replacement = await findRefreshSession(
      db,
      session.refreshTokenReplacedByToken,
    );
    if (
      replacement?.refreshTokenFamilyId === familyId &&
      replacement.userId === session.userId &&
      replacement.expiresAt > now &&
      !replacement.refreshTokenConsumedAt &&
      !replacement.refreshTokenRevokedAt
    ) {
      return {
        userId: replacement.userId,
        refreshToken: replacement.token,
        refreshTokenExpiresAt: replacement.expiresAt,
      };
    }
  }

  await revokeRefreshTokenFamily(db, familyId, now);
  return null;
}

export async function rotateSessionByToken({
  token,
  replacementToken,
  replacementExpiresAt,
  legacyNativeSessionAdoption,
  now = new Date(),
  prisma,
}: {
  token: string;
  replacementToken: string;
  replacementExpiresAt: Date;
  legacyNativeSessionAdoption?: LegacyNativeSessionAdoption;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<RotateSessionResult | null> {
  if (replacementExpiresAt <= now) {
    throw new RangeError("Replacement session must expire in the future");
  }
  if (legacyNativeSessionAdoption?.familyId.length === 0) {
    throw new TypeError("Legacy native session family ID must not be empty");
  }

  const rotate = async (db: PrismaTransaction) => {
    const session = await findRefreshSession(db, token);
    if (!session || session.refreshTokenRevokedAt) {
      return null;
    }

    let familyId = session.refreshTokenFamilyId;
    if (!familyId) {
      if (
        !legacyNativeSessionAdoption ||
        session.expiresAt <= now ||
        session.refreshTokenConsumedAt ||
        session.refreshTokenReplacedByToken
      ) {
        return null;
      }
      familyId = legacyNativeSessionAdoption.familyId;
    }

    if (session.refreshTokenConsumedAt) {
      return await reuseReplacementOrRevokeFamily(db, session, now);
    }
    if (session.expiresAt <= now) {
      return null;
    }

    const consumed = await db.session.updateMany({
      where: {
        token: session.token,
        refreshTokenFamilyId: session.refreshTokenFamilyId,
        refreshTokenConsumedAt: null,
        refreshTokenRevokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenFamilyId: familyId,
        refreshTokenConsumedAt: now,
        refreshTokenReplacedByToken: replacementToken,
      },
    });
    if (consumed.count !== 1) {
      const current = await findRefreshSession(db, token);
      if (
        current?.refreshTokenFamilyId &&
        (session.refreshTokenFamilyId === null ||
          current.refreshTokenFamilyId === familyId) &&
        current.refreshTokenConsumedAt &&
        !current.refreshTokenRevokedAt
      ) {
        return await reuseReplacementOrRevokeFamily(db, current, now);
      }
      return null;
    }

    await db.session.updateMany({
      where: {
        refreshTokenFamilyId: familyId,
        expiresAt: { lt: replacementExpiresAt },
      },
      data: {
        expiresAt: replacementExpiresAt,
      },
    });
    await db.session.create({
      data: {
        token: replacementToken,
        expiresAt: replacementExpiresAt,
        userId: session.userId,
        refreshTokenFamilyId: familyId,
      },
    });
    return {
      userId: session.userId,
      refreshToken: replacementToken,
      refreshTokenExpiresAt: replacementExpiresAt,
    };
  };

  return prisma ? await rotate(prisma) : await startTransaction(rotate);
}

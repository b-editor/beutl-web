import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export async function createSession({
  token,
  expiresAt,
  userId,
  prisma,
}: {
  token: string;
  expiresAt: Date;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.session.create({
    data: {
      token,
      expiresAt,
      userId,
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

export async function createNativeRefreshToken({
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
  const create = async (db: PrismaTransaction) => {
    await purgeOneExpiredRefreshTokenFamily(db, new Date());
    await db.refreshTokenFamily.create({
      data: {
        id: refreshTokenFamilyId,
        userId,
        expiresAt,
      },
    });
    return await db.nativeRefreshToken.create({
      data: {
        token,
        expiresAt,
        userId,
        refreshTokenFamilyId,
      },
    });
  };

  return prisma
    ? await create(prisma)
    : await startRetryableTransaction(create);
}

export const REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS = 10_000;

type NativeRefreshToken = {
  token: string;
  userId: string;
  expiresAt: Date;
  refreshTokenFamilyId: string;
  refreshTokenConsumedAt: Date | null;
  refreshTokenReplacedByToken: string | null;
};

type LegacySession = {
  token: string;
  userId: string;
  expiresAt: Date;
};

type RefreshTokenFamily = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type RotateNativeRefreshTokenResult = {
  userId: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

// This capability must come from a successfully decrypted native refresh
// request. General session callers must omit it so browser sessions cannot be
// migrated into the native refresh-token store.
export type LegacyNativeSessionAdoption = {
  familyId: string;
};

async function findNativeRefreshToken(
  db: PrismaTransaction,
  token: string,
): Promise<NativeRefreshToken | null> {
  return await db.nativeRefreshToken.findUnique({
    where: { token },
    select: {
      token: true,
      userId: true,
      expiresAt: true,
      refreshTokenFamilyId: true,
      refreshTokenConsumedAt: true,
      refreshTokenReplacedByToken: true,
    },
  });
}

async function findLegacySession(
  db: PrismaTransaction,
  token: string,
): Promise<LegacySession | null> {
  return await db.session.findUnique({
    where: { token },
    select: {
      token: true,
      userId: true,
      expiresAt: true,
    },
  });
}

async function findRefreshTokenFamily(
  db: PrismaTransaction,
  familyId: string,
): Promise<RefreshTokenFamily | null> {
  return await db.refreshTokenFamily.findUnique({
    where: { id: familyId },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
}

async function purgeOneExpiredRefreshTokenFamily(
  db: PrismaTransaction,
  now: Date,
) {
  const expiredFamily = await db.refreshTokenFamily.findFirst({
    where: {
      expiresAt: { lte: now },
    },
    orderBy: {
      expiresAt: "asc",
    },
    select: {
      id: true,
    },
  });
  if (expiredFamily) {
    await db.refreshTokenFamily.deleteMany({
      where: {
        id: expiredFamily.id,
        expiresAt: { lte: now },
      },
    });
  }
}

async function purgeExpiredRefreshTokenTombstones(
  db: PrismaTransaction,
  familyId: string,
  now: Date,
) {
  await db.nativeRefreshToken.deleteMany({
    where: {
      refreshTokenFamilyId: familyId,
      refreshTokenConsumedAt: { not: null },
      expiresAt: { lte: now },
    },
  });
}

async function revokeRefreshTokenFamily(
  db: PrismaTransaction,
  familyId: string,
  now: Date,
) {
  await db.refreshTokenFamily.updateMany({
    where: {
      id: familyId,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
    },
  });
}

async function adoptLegacyNativeSession(
  db: PrismaTransaction,
  token: string,
  familyId: string,
  familyExpiresAt: Date,
  now: Date,
): Promise<{
  refreshToken: NativeRefreshToken;
  family: RefreshTokenFamily;
} | null> {
  const legacySession = await findLegacySession(db, token);
  if (!legacySession || legacySession.expiresAt <= now) {
    return null;
  }

  const family = await db.refreshTokenFamily.create({
    data: {
      id: familyId,
      userId: legacySession.userId,
      expiresAt: familyExpiresAt,
    },
  });
  const refreshToken = await db.nativeRefreshToken.create({
    data: {
      token: legacySession.token,
      userId: legacySession.userId,
      expiresAt: legacySession.expiresAt,
      refreshTokenFamilyId: familyId,
    },
  });
  const deleted = await db.session.deleteMany({
    where: {
      token: legacySession.token,
      userId: legacySession.userId,
      expiresAt: { gt: now },
    },
  });
  if (deleted.count !== 1) {
    throw new Error("Legacy native session changed during adoption");
  }

  return { refreshToken, family };
}

async function reuseReplacementOrRevokeFamily(
  db: PrismaTransaction,
  refreshToken: NativeRefreshToken,
  family: RefreshTokenFamily,
  now: Date,
): Promise<RotateNativeRefreshTokenResult | null> {
  const consumedAt = refreshToken.refreshTokenConsumedAt;
  if (!consumedAt) {
    return null;
  }
  const graceExpiresAt =
    consumedAt.getTime() + REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS;
  if (
    now.getTime() <= graceExpiresAt &&
    refreshToken.refreshTokenReplacedByToken
  ) {
    const replacement = await findNativeRefreshToken(
      db,
      refreshToken.refreshTokenReplacedByToken,
    );
    if (
      replacement?.refreshTokenFamilyId === family.id &&
      replacement.userId === refreshToken.userId &&
      replacement.expiresAt > now &&
      !replacement.refreshTokenConsumedAt
    ) {
      return {
        userId: replacement.userId,
        refreshToken: replacement.token,
        refreshTokenExpiresAt: replacement.expiresAt,
      };
    }
  }

  await revokeRefreshTokenFamily(db, family.id, now);
  return null;
}

export async function rotateNativeRefreshTokenByToken({
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
}): Promise<RotateNativeRefreshTokenResult | null> {
  if (replacementExpiresAt <= now) {
    throw new RangeError("Replacement refresh token must expire in the future");
  }
  if (legacyNativeSessionAdoption?.familyId.length === 0) {
    throw new TypeError("Legacy native session family ID must not be empty");
  }

  const rotate = async (db: PrismaTransaction) => {
    let refreshToken = await findNativeRefreshToken(db, token);
    let family = refreshToken
      ? await findRefreshTokenFamily(db, refreshToken.refreshTokenFamilyId)
      : null;

    if (!refreshToken) {
      if (!legacyNativeSessionAdoption) {
        return null;
      }
      const adopted = await adoptLegacyNativeSession(
        db,
        token,
        legacyNativeSessionAdoption.familyId,
        replacementExpiresAt,
        now,
      );
      if (!adopted) {
        return null;
      }
      refreshToken = adopted.refreshToken;
      family = adopted.family;
    }

    if (family && family.expiresAt <= now) {
      await db.refreshTokenFamily.deleteMany({
        where: {
          id: family.id,
          expiresAt: { lte: now },
        },
      });
      return null;
    }
    if (
      !family ||
      family.userId !== refreshToken.userId ||
      family.revokedAt
    ) {
      return null;
    }

    await purgeOneExpiredRefreshTokenFamily(db, now);
    if (refreshToken.refreshTokenConsumedAt) {
      return await reuseReplacementOrRevokeFamily(
        db,
        refreshToken,
        family,
        now,
      );
    }
    if (refreshToken.expiresAt <= now) {
      return null;
    }

    const consumed = await db.nativeRefreshToken.updateMany({
      where: {
        token: refreshToken.token,
        refreshTokenFamilyId: refreshToken.refreshTokenFamilyId,
        refreshTokenConsumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenConsumedAt: now,
        refreshTokenReplacedByToken: replacementToken,
      },
    });
    if (consumed.count !== 1) {
      const current = await findNativeRefreshToken(db, token);
      if (
        current?.refreshTokenFamilyId === family.id &&
        current.refreshTokenConsumedAt
      ) {
        const currentFamily = await findRefreshTokenFamily(
          db,
          current.refreshTokenFamilyId,
        );
        if (
          currentFamily &&
          currentFamily.userId === current.userId &&
          !currentFamily.revokedAt &&
          currentFamily.expiresAt > now
        ) {
          return await reuseReplacementOrRevokeFamily(
            db,
            current,
            currentFamily,
            now,
          );
        }
      }
      return null;
    }

    await db.refreshTokenFamily.updateMany({
      where: {
        id: family.id,
        revokedAt: null,
        expiresAt: { lt: replacementExpiresAt },
      },
      data: {
        expiresAt: replacementExpiresAt,
      },
    });
    await db.nativeRefreshToken.create({
      data: {
        token: replacementToken,
        expiresAt: replacementExpiresAt,
        userId: refreshToken.userId,
        refreshTokenFamilyId: family.id,
      },
    });
    await purgeExpiredRefreshTokenTombstones(db, family.id, now);
    return {
      userId: refreshToken.userId,
      refreshToken: replacementToken,
      refreshTokenExpiresAt: replacementExpiresAt,
    };
  };

  return prisma ? await rotate(prisma) : await startRetryableTransaction(rotate);
}

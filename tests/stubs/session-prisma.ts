export type SessionRecord = {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

export type NativeRefreshTokenRecord = {
  token: string;
  userId: string;
  expiresAt: Date;
  refreshTokenFamilyId: string;
  refreshTokenConsumedAt: Date | null;
  refreshTokenReplacedByToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RefreshTokenFamilyRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionSeed = Pick<
  SessionRecord,
  "token" | "userId" | "expiresAt"
> &
  Partial<Omit<SessionRecord, "token" | "userId" | "expiresAt">>;

type NativeRefreshTokenSeed = Pick<
  NativeRefreshTokenRecord,
  "token" | "userId" | "expiresAt" | "refreshTokenFamilyId"
> &
  Partial<
    Omit<
      NativeRefreshTokenRecord,
      "token" | "userId" | "expiresAt" | "refreshTokenFamilyId"
    >
  >;

type RefreshTokenFamilySeed = Pick<
  RefreshTokenFamilyRecord,
  "id" | "userId" | "expiresAt"
> &
  Partial<
    Omit<RefreshTokenFamilyRecord, "id" | "userId" | "expiresAt">
  >;

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  };
}

function cloneNativeRefreshToken(
  refreshToken: NativeRefreshTokenRecord,
): NativeRefreshTokenRecord {
  return {
    ...refreshToken,
    expiresAt: new Date(refreshToken.expiresAt),
    createdAt: new Date(refreshToken.createdAt),
    updatedAt: new Date(refreshToken.updatedAt),
    refreshTokenConsumedAt: refreshToken.refreshTokenConsumedAt
      ? new Date(refreshToken.refreshTokenConsumedAt)
      : null,
  };
}

function cloneFamily(
  family: RefreshTokenFamilyRecord,
): RefreshTokenFamilyRecord {
  return {
    ...family,
    expiresAt: new Date(family.expiresAt),
    revokedAt: family.revokedAt ? new Date(family.revokedAt) : null,
    createdAt: new Date(family.createdAt),
    updatedAt: new Date(family.updatedAt),
  };
}

function matchesWhere<T extends Record<string, unknown>>(
  record: T,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) {
      return true;
    }

    const actual = record[key as keyof T];
    if (
      typeof expected === "object" &&
      expected !== null &&
      !(expected instanceof Date) &&
      "not" in expected &&
      actual === expected.not
    ) {
      return false;
    }
    if (
      actual instanceof Date &&
      typeof expected === "object" &&
      expected !== null &&
      !(expected instanceof Date)
    ) {
      const filter = expected as {
        gt?: Date;
        gte?: Date;
        lt?: Date;
        lte?: Date;
      };
      return (
        (filter.gt === undefined || actual > filter.gt) &&
        (filter.gte === undefined || actual >= filter.gte) &&
        (filter.lt === undefined || actual < filter.lt) &&
        (filter.lte === undefined || actual <= filter.lte)
      );
    }
    if (actual instanceof Date && expected instanceof Date) {
      return actual.getTime() === expected.getTime();
    }
    return actual === expected;
  });
}

export function createSessionPrisma(initialSessions: SessionSeed[] = []) {
  let nextSessionId = 1;
  const sessions = new Map<string, SessionRecord>();
  const refreshTokens = new Map<string, NativeRefreshTokenRecord>();
  const families = new Map<string, RefreshTokenFamilyRecord>();

  const toSessionRecord = (seed: SessionSeed): SessionRecord => {
    const timestamp = new Date();
    return {
      id: seed.id ?? `session-${nextSessionId++}`,
      token: seed.token,
      userId: seed.userId,
      expiresAt: new Date(seed.expiresAt),
      createdAt: seed.createdAt ? new Date(seed.createdAt) : timestamp,
      updatedAt: seed.updatedAt ? new Date(seed.updatedAt) : timestamp,
      ipAddress: seed.ipAddress ?? null,
      userAgent: seed.userAgent ?? null,
    };
  };

  const toNativeRefreshTokenRecord = (
    seed: NativeRefreshTokenSeed,
  ): NativeRefreshTokenRecord => {
    const timestamp = new Date();
    return {
      token: seed.token,
      userId: seed.userId,
      expiresAt: new Date(seed.expiresAt),
      refreshTokenFamilyId: seed.refreshTokenFamilyId,
      refreshTokenConsumedAt: seed.refreshTokenConsumedAt
        ? new Date(seed.refreshTokenConsumedAt)
        : null,
      refreshTokenReplacedByToken:
        seed.refreshTokenReplacedByToken ?? null,
      createdAt: seed.createdAt ? new Date(seed.createdAt) : timestamp,
      updatedAt: seed.updatedAt ? new Date(seed.updatedAt) : timestamp,
    };
  };

  const toFamilyRecord = (
    seed: RefreshTokenFamilySeed,
  ): RefreshTokenFamilyRecord => {
    const timestamp = new Date();
    return {
      id: seed.id,
      userId: seed.userId,
      expiresAt: new Date(seed.expiresAt),
      revokedAt: seed.revokedAt ? new Date(seed.revokedAt) : null,
      createdAt: seed.createdAt ? new Date(seed.createdAt) : timestamp,
      updatedAt: seed.updatedAt ? new Date(seed.updatedAt) : timestamp,
    };
  };

  for (const seed of initialSessions) {
    sessions.set(seed.token, toSessionRecord(seed));
  }

  const session = {
    findUnique: async ({ where }: { where: { token: string } }) => {
      const record = sessions.get(where.token);
      return record ? cloneSession(record) : null;
    },
    create: async ({ data }: { data: SessionSeed }) => {
      if (sessions.has(data.token)) {
        throw new Error(`Duplicate session token: ${data.token}`);
      }
      const record = toSessionRecord(data);
      sessions.set(record.token, record);
      return cloneSession(record);
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;
      for (const [token, record] of sessions) {
        if (matchesWhere(record, where)) {
          sessions.delete(token);
          count++;
        }
      }
      return { count };
    },
  };

  const nativeRefreshToken = {
    findUnique: async ({ where }: { where: { token: string } }) => {
      const record = refreshTokens.get(where.token);
      return record ? cloneNativeRefreshToken(record) : null;
    },
    create: async ({ data }: { data: NativeRefreshTokenSeed }) => {
      if (refreshTokens.has(data.token)) {
        throw new Error(`Duplicate native refresh token: ${data.token}`);
      }
      const record = toNativeRefreshTokenRecord(data);
      refreshTokens.set(record.token, record);
      return cloneNativeRefreshToken(record);
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<NativeRefreshTokenRecord>;
    }) => {
      let count = 0;
      for (const [token, record] of refreshTokens) {
        if (!matchesWhere(record, where)) {
          continue;
        }
        refreshTokens.set(
          token,
          cloneNativeRefreshToken({
            ...record,
            ...data,
            updatedAt: new Date(),
          }),
        );
        count++;
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;
      for (const [token, record] of refreshTokens) {
        if (matchesWhere(record, where)) {
          refreshTokens.delete(token);
          count++;
        }
      }
      return { count };
    },
  };

  const refreshTokenFamily = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const family = families.get(where.id);
      return family ? cloneFamily(family) : null;
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy: { expiresAt: "asc" | "desc" };
    }) => {
      const matches = [...families.values()]
        .filter((family) => matchesWhere(family, where))
        .sort((left, right) => {
          const direction = orderBy.expiresAt === "asc" ? 1 : -1;
          return (
            direction *
            (left.expiresAt.getTime() - right.expiresAt.getTime())
          );
        });
      return matches[0] ? cloneFamily(matches[0]) : null;
    },
    create: async ({ data }: { data: RefreshTokenFamilySeed }) => {
      if (families.has(data.id)) {
        throw new Error(`Duplicate refresh token family: ${data.id}`);
      }
      const family = toFamilyRecord(data);
      families.set(family.id, family);
      return cloneFamily(family);
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<RefreshTokenFamilyRecord>;
    }) => {
      let count = 0;
      for (const [id, family] of families) {
        if (!matchesWhere(family, where)) {
          continue;
        }
        families.set(
          id,
          cloneFamily({
            ...family,
            ...data,
            updatedAt: new Date(),
          }),
        );
        count++;
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;
      for (const [id, family] of families) {
        if (!matchesWhere(family, where)) {
          continue;
        }
        families.delete(id);
        for (const [token, refreshToken] of refreshTokens) {
          if (refreshToken.refreshTokenFamilyId === id) {
            refreshTokens.delete(token);
          }
        }
        count++;
      }
      return { count };
    },
  };

  let transactionQueue = Promise.resolve();
  const prisma = {
    session,
    nativeRefreshToken,
    refreshTokenFamily,
    $transaction: async <T>(
      callback: (transaction: {
        session: typeof session;
        nativeRefreshToken: typeof nativeRefreshToken;
        refreshTokenFamily: typeof refreshTokenFamily;
      }) => Promise<T>,
    ) => {
      const previous = transactionQueue;
      let release!: () => void;
      transactionQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;

      const sessionSnapshot = new Map(
        [...sessions].map(([token, record]) => [token, cloneSession(record)]),
      );
      const refreshTokenSnapshot = new Map(
        [...refreshTokens].map(([token, record]) => [
          token,
          cloneNativeRefreshToken(record),
        ]),
      );
      const familySnapshot = new Map(
        [...families].map(([id, family]) => [id, cloneFamily(family)]),
      );
      try {
        return await callback({
          session,
          nativeRefreshToken,
          refreshTokenFamily,
        });
      } catch (error) {
        sessions.clear();
        for (const [token, record] of sessionSnapshot) {
          sessions.set(token, record);
        }
        refreshTokens.clear();
        for (const [token, record] of refreshTokenSnapshot) {
          refreshTokens.set(token, record);
        }
        families.clear();
        for (const [id, family] of familySnapshot) {
          families.set(id, family);
        }
        throw error;
      } finally {
        release();
      }
    },
  };

  return {
    prisma,
    get(token: string) {
      const record = refreshTokens.get(token);
      return record ? cloneNativeRefreshToken(record) : null;
    },
    all() {
      return [...refreshTokens.values()].map(cloneNativeRefreshToken);
    },
    update(token: string, data: Partial<NativeRefreshTokenRecord>) {
      const record = refreshTokens.get(token);
      if (!record) {
        throw new Error(`Unknown native refresh token: ${token}`);
      }
      refreshTokens.set(
        token,
        cloneNativeRefreshToken({ ...record, ...data }),
      );
    },
    getSession(token: string) {
      const record = sessions.get(token);
      return record ? cloneSession(record) : null;
    },
    allSessions() {
      return [...sessions.values()].map(cloneSession);
    },
    moveNativeTokenToLegacySession(token: string) {
      const refreshToken = refreshTokens.get(token);
      if (!refreshToken) {
        throw new Error(`Unknown native refresh token: ${token}`);
      }
      refreshTokens.delete(token);
      sessions.set(
        token,
        toSessionRecord({
          token,
          userId: refreshToken.userId,
          expiresAt: refreshToken.expiresAt,
          createdAt: refreshToken.createdAt,
          updatedAt: refreshToken.updatedAt,
        }),
      );
    },
    getFamily(id: string) {
      const family = families.get(id);
      return family ? cloneFamily(family) : null;
    },
    allFamilies() {
      return [...families.values()].map(cloneFamily);
    },
    deleteFamily(id: string) {
      families.delete(id);
    },
    updateFamily(id: string, data: Partial<RefreshTokenFamilyRecord>) {
      const family = families.get(id);
      if (!family) {
        throw new Error(`Unknown refresh token family: ${id}`);
      }
      families.set(id, cloneFamily({ ...family, ...data }));
    },
  };
}

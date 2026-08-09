export type SessionRecord = {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  refreshTokenFamilyId: string | null;
  refreshTokenConsumedAt: Date | null;
  refreshTokenReplacedByToken: string | null;
  refreshTokenRevokedAt: Date | null;
};

export type SessionSeed = Pick<
  SessionRecord,
  "token" | "userId" | "expiresAt"
> &
  Partial<Omit<SessionRecord, "token" | "userId" | "expiresAt">>;

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    refreshTokenConsumedAt: session.refreshTokenConsumedAt
      ? new Date(session.refreshTokenConsumedAt)
      : null,
    refreshTokenRevokedAt: session.refreshTokenRevokedAt
      ? new Date(session.refreshTokenRevokedAt)
      : null,
  };
}

function matchesWhere(
  session: SessionRecord,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) {
      return true;
    }

    const actual = session[key as keyof SessionRecord];
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

export function createSessionPrisma(initial: SessionSeed[] = []) {
  let nextId = 1;
  const records = new Map<string, SessionRecord>();

  const toRecord = (seed: SessionSeed): SessionRecord => {
    const timestamp = new Date();
    return {
      id: seed.id ?? `session-${nextId++}`,
      token: seed.token,
      userId: seed.userId,
      expiresAt: new Date(seed.expiresAt),
      createdAt: seed.createdAt ? new Date(seed.createdAt) : timestamp,
      updatedAt: seed.updatedAt ? new Date(seed.updatedAt) : timestamp,
      ipAddress: seed.ipAddress ?? null,
      userAgent: seed.userAgent ?? null,
      refreshTokenFamilyId: seed.refreshTokenFamilyId ?? null,
      refreshTokenConsumedAt: seed.refreshTokenConsumedAt
        ? new Date(seed.refreshTokenConsumedAt)
        : null,
      refreshTokenReplacedByToken:
        seed.refreshTokenReplacedByToken ?? null,
      refreshTokenRevokedAt: seed.refreshTokenRevokedAt
        ? new Date(seed.refreshTokenRevokedAt)
        : null,
    };
  };

  for (const seed of initial) {
    records.set(seed.token, toRecord(seed));
  }

  const session = {
    findUnique: async ({ where }: { where: { token: string } }) => {
      const record = records.get(where.token);
      return record ? cloneSession(record) : null;
    },
    create: async ({ data }: { data: SessionSeed }) => {
      if (records.has(data.token)) {
        throw new Error(`Duplicate session token: ${data.token}`);
      }
      const record = toRecord(data);
      records.set(record.token, record);
      return cloneSession(record);
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<SessionRecord>;
    }) => {
      let count = 0;
      for (const [token, record] of records) {
        if (!matchesWhere(record, where)) {
          continue;
        }
        records.set(
          token,
          cloneSession({
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
      for (const [token, record] of records) {
        if (matchesWhere(record, where)) {
          records.delete(token);
          count++;
        }
      }
      return { count };
    },
  };

  let transactionQueue = Promise.resolve();
  const prisma = {
    session,
    $transaction: async <T>(
      callback: (transaction: { session: typeof session }) => Promise<T>,
    ) => {
      const previous = transactionQueue;
      let release!: () => void;
      transactionQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;

      const snapshot = new Map(
        [...records].map(([token, record]) => [token, cloneSession(record)]),
      );
      try {
        return await callback({ session });
      } catch (error) {
        records.clear();
        for (const [token, record] of snapshot) {
          records.set(token, record);
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
      const record = records.get(token);
      return record ? cloneSession(record) : null;
    },
    all() {
      return [...records.values()].map(cloneSession);
    },
    update(token: string, data: Partial<SessionRecord>) {
      const record = records.get(token);
      if (!record) {
        throw new Error(`Unknown session token: ${token}`);
      }
      records.set(token, cloneSession({ ...record, ...data }));
    },
  };
}

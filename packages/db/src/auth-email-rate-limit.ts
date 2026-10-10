import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

export type AuthEmailSendLimit = { key: string; max: number; windowMilliseconds: number };

/** All counters commit together, across both Workers and concurrent requests. */
export async function consumeAuthEmailSendLimits(
  limits: readonly AuthEmailSendLimit[],
  now = new Date(),
  prisma?: PrismaTransaction,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const consume = async (db: PrismaTransaction) => {
    const counters = [];
    // A fixed order avoids lock-order inversions for shared IP/recipient rows.
    for (const limit of [...limits].sort((a, b) => a.key.localeCompare(b.key))) {
      const row = await db.authEmailRateLimit.findUnique({ where: { key: limit.key } });
      if (row && row.expiresAt > now && row.count >= limit.max) {
        return {
          allowed: false as const,
          retryAfter: Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000)),
        };
      }
      counters.push({ limit, row });
    }
    for (const { limit, row } of counters) {
      if (!row || row.expiresAt <= now) {
        const data = { count: 1, expiresAt: new Date(now.getTime() + limit.windowMilliseconds) };
        await db.authEmailRateLimit.upsert({
          where: { key: limit.key },
          create: { key: limit.key, ...data },
          update: data,
        });
      } else {
        await db.authEmailRateLimit.update({
          where: { key: limit.key },
          data: { count: { increment: 1 } },
        });
      }
    }
    return { allowed: true as const };
  };
  return prisma
    ? consume(prisma)
    : startRetryableTransaction(consume, { isolationLevel: "Serializable" });
}

/** Bound maintenance work and recheck expiry in case another sender renewed a row. */
export async function pruneAuthEmailSendLimits(now = new Date()): Promise<void> {
  const db = await getDb();
  const expired = await db.authEmailRateLimit.findMany({
    where: { expiresAt: { lte: now } },
    select: { key: true },
    take: 100,
  });
  if (expired.length)
    await db.authEmailRateLimit.deleteMany({
      where: { key: { in: expired.map(({ key }) => key) }, expiresAt: { lte: now } },
    });
}

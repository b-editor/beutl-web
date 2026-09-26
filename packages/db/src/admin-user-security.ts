import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// 1 ユーザーが同時に持つセッションは通常数件。異常に多い場合でも画面を壊さない上限。
export const USER_SECURITY_RELATION_LIMIT = 50;

// 管理画面のユーザー詳細に出すサインイン手段とセッション。トークンやパスワード
// ハッシュ、公開鍵などの秘密に近い値は選ばない。
export async function getUserSecurityOverview({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const [accounts, passkeys, sessions, refreshTokenFamilies, activeRefreshTokenFamilyCount] = await Promise.all([
    db.account.findMany({
      where: { userId },
      select: { id: true, providerId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.passkey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        deviceType: true,
        backedUp: true,
        createdAt: true,
        usedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: USER_SECURITY_RELATION_LIMIT + 1,
    }),
    db.session.findMany({
      where: { userId, expiresAt: { gt: now } },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: USER_SECURITY_RELATION_LIMIT + 1,
    }),
    db.refreshTokenFamily.findMany({
      where: { userId, expiresAt: { gt: now } },
      select: { id: true, createdAt: true, expiresAt: true, revokedAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: USER_SECURITY_RELATION_LIMIT + 1,
    }),
    // 一覧は打ち切るので、失効できるものが残っているかは上限に依らず数える。
    db.refreshTokenFamily.count({
      where: { userId, expiresAt: { gt: now }, revokedAt: null },
    }),
  ]);
  return {
    activeRefreshTokenFamilyCount,
    accounts,
    passkeys,
    sessions,
    refreshTokenFamilies,
  };
}

// Web のセッションを削除し、デスクトップアプリのリフレッシュトークン系列を失効させる。
// 失効済みの系列は rotateNativeRefreshTokenByToken が拒否するため、アプリは次の
// 更新で再サインインを求められる。発行済みのアクセストークン (JWT) と Web の
// cookie キャッシュはそれぞれの有効期限までは残る。
export async function revokeAllUserSessions({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  // 同じトランザクションに載るので順に発行する。
  const sessions = await db.session.deleteMany({ where: { userId } });
  const refreshTokenFamilies = await db.refreshTokenFamily.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  return {
    sessions: sessions.count,
    refreshTokenFamilies: refreshTokenFamilies.count,
  };
}

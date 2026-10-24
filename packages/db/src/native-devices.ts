import { NATIVE_CLIENT_ID, nativeOAuthConfirmation } from "@beutl/core";
import { getDb } from "./provider";
import { startRetryableTransaction } from "./transaction";

export async function listNativeDevices(userId: string) {
  const db = await getDb();
  const [devices, grants] = await Promise.all([
    db.nativeDevice.findMany({
      where: { userId, clientId: NATIVE_CLIENT_ID },
      orderBy: { createdAt: "desc" },
    }),
    db.oauthRefreshToken.findMany({
      where: { userId, clientId: NATIVE_CLIENT_ID, revoked: null, expiresAt: { gt: new Date() } },
      select: { confirmation: true },
    }),
  ]);
  const keys = new Set(grants.map(({ confirmation }) => confirmation));
  return devices
    .filter((device) => keys.has(nativeOAuthConfirmation(device.keyThumbprint)))
    .map(({ id, name, createdAt }) => ({ id, name, createdAt: createdAt.toISOString() }));
}

export async function revokeNativeDevice(userId: string, id: string) {
  return startRetryableTransaction(async (tx) => {
    const device = await tx.nativeDevice.findFirst({
      where: { id, userId, clientId: NATIVE_CLIENT_ID },
    });
    if (!device) return false;
    const where = {
      userId,
      clientId: NATIVE_CLIENT_ID,
      confirmation: nativeOAuthConfirmation(device.keyThumbprint),
    };
    // Delete this device's grants, including rotated tokens: Better Auth treats
    // revoked-token reuse as a reason to invalidate every grant for the client/user.
    await tx.oauthAccessToken.deleteMany({ where });
    await tx.oauthRefreshToken.deleteMany({ where });
    await tx.nativeDevice.delete({ where: { id } });
    return true;
  });
}

// Includes provider-owned DPoP reservations and expired authorization codes.
export async function cleanupExpiredAuthVerifications(now: Date) {
  const db = await getDb();
  const expired = await db.verification.findMany({
    where: { expiresAt: { lt: now } },
    orderBy: { expiresAt: "asc" },
    take: 10_000,
    select: { id: true },
  });
  if (!expired.length) return { count: 0 };
  return db.verification.deleteMany({
    where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lt: now } },
  });
}

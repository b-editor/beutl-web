// What the desktop app is told about storage: the plan in force, the quota it
// grants, and how much of it is used. Composed next to the AI entitlements in
// the v3 route rather than inside getEntitlements, which also runs on every AI
// job start and has no business summing files there.
import {
  effectiveSubscriptionEnd,
  type StorageTierId,
} from "@beutl/core";
import {
  countFilesByUserId,
  countStorageUploadsByUserId,
  resolveStorageQuota,
  sumFileSizeByUserId,
  sumStorageUploadSizeByUserId,
  type PrismaTransaction,
} from "@beutl/db";

export type StorageEntitlementResponse = {
  // null は無料枠。
  plan: StorageTierId | null;
  quotaBytes: number;
  // 完成したファイルの合計。AI の生成結果は数えない (Web の表示と同じ値)。
  usedBytes: number;
  fileCount: number;
  fileCountLimit: number;
  canUpload: boolean;
  subscriptionStatus: string | null;
  currentPeriodStart: string | null;
  // cancel_at を考慮した実効の終了。
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export async function getStorageEntitlement(
  userId: string,
  options: { prisma?: PrismaTransaction; now?: Date } = {},
): Promise<StorageEntitlementResponse> {
  const now = options.now ?? new Date();
  // Whether an upload can start is judged the way the start path judges it:
  // completed files plus what uploads still in flight have reserved, in both
  // bytes and slots. Reporting only the completed usage would say "yes" to a
  // client whose next start is refused.
  const [quota, usedBytes, fileCount, reservedBytes, activeUploads] =
    await Promise.all([
      resolveStorageQuota({ userId, prisma: options.prisma, now }),
      sumFileSizeByUserId({ userId, prisma: options.prisma }),
      countFilesByUserId({ userId, prisma: options.prisma }),
      sumStorageUploadSizeByUserId({ userId, prisma: options.prisma }),
      countStorageUploadsByUserId({ userId, prisma: options.prisma }),
    ]);
  const used = Number(usedBytes);
  const committed = Number(usedBytes + reservedBytes);
  const subscription = quota.subscription;
  const effectiveEnd = subscription
    ? effectiveSubscriptionEnd(subscription)
    : null;
  return {
    plan: quota.tier,
    quotaBytes: quota.quotaBytes,
    usedBytes: used,
    fileCount,
    fileCountLimit: quota.fileCountLimit,
    canUpload:
      committed < quota.quotaBytes &&
      fileCount + activeUploads < quota.fileCountLimit,
    subscriptionStatus: subscription?.status ?? null,
    currentPeriodStart: subscription?.currentPeriodStart
      ? subscription.currentPeriodStart.toISOString()
      : null,
    currentPeriodEnd: effectiveEnd ? effectiveEnd.toISOString() : null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
  };
}

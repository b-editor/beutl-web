import {
  STORAGE_PLAN,
  activeSubscriptionTierOf,
  storageQuotaFor,
  type StorageQuota,
} from "@beutl/core";
import { getSubscription } from "./subscription";
import type { PrismaTransaction } from "./transaction";

export type ResolvedStorageQuota = StorageQuota & {
  subscription: Awaited<ReturnType<typeof getSubscription>>;
};

// 今このユーザーに許される容量。契約行を主キーで 1 回読むだけなので、アップロードの
// 取引の中から呼んで、プランの変更とアップロードが交錯しないようにする。
// 削除意図は見ない。容量は消費物ではなく、削除中の口座はどのみち何も書けない。
export async function resolveStorageQuota({
  userId,
  prisma,
  now = new Date(),
}: {
  userId: string;
  prisma?: PrismaTransaction;
  now?: Date;
}): Promise<ResolvedStorageQuota> {
  const subscription = await getSubscription({
    userId,
    planId: STORAGE_PLAN.id,
    prisma,
  });
  return {
    ...storageQuotaFor(
      activeSubscriptionTierOf(subscription, STORAGE_PLAN.id, now),
    ),
    subscription,
  };
}

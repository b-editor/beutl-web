import {
  STORAGE_PLAN,
  activeSubscriptionTierOf,
  storageQuotaFor,
  type StorageQuota,
} from "@beutl/core";
import {
  getEntitlementSubscription,
  type EntitlementSubscription,
} from "./subscription-grant";
import type { PrismaTransaction } from "./transaction";

type ResolvedStorageQuota = StorageQuota & {
  // 容量を決めた契約。Stripe の契約が有効でなく管理者の付与が効いていれば付与
  // (source: "grant")。
  subscription: EntitlementSubscription | null;
};

// 今このユーザーに許される容量。契約行を主キーで読み、Stripe の契約が権利を与えて
// いなければ付与も読む。アップロードの取引の中から呼んで、プランの変更とアップロードが
// 交錯しないようにする。
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
  const subscription = await getEntitlementSubscription({
    userId,
    planId: STORAGE_PLAN.id,
    now,
    prisma,
  });
  return {
    ...storageQuotaFor(
      activeSubscriptionTierOf(subscription, STORAGE_PLAN.id, now),
    ),
    subscription,
  };
}

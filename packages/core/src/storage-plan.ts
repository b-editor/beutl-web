// ストレージプランのティアと容量。ティアと容量の対応はここが唯一の定義元で、
// 判定 (アップロード) と表示 (ダッシュボード・請求ページ・管理画面) が共有する。
// 契約そのものの扱い (有効判定など) はプラン共通の subscription-plans.ts にある。
import {
  STORAGE_FREE_FILE_COUNT_LIMIT,
  STORAGE_FREE_QUOTA_BYTES,
  STORAGE_PAID_FILE_COUNT_LIMIT,
} from "./storage-quota";

// Stripe の metadata.planId と Subscription.planId に入る値。
export const STORAGE_PLAN = { id: "storage" } as const;

export const STORAGE_TIER_IDS = ["100gb", "200gb", "1tb"] as const;
export type StorageTierId = (typeof STORAGE_TIER_IDS)[number];

export type StorageTier = {
  id: StorageTierId;
  quotaBytes: number;
  fileCountLimit: number;
};

const GIB = 1024 * 1024 * 1024;

// 昇順。値はすべて 2^40 以下なので number で正確に表せる。
export const STORAGE_PLAN_TIERS: readonly StorageTier[] = [
  { id: "100gb", quotaBytes: 100 * GIB, fileCountLimit: STORAGE_PAID_FILE_COUNT_LIMIT },
  { id: "200gb", quotaBytes: 200 * GIB, fileCountLimit: STORAGE_PAID_FILE_COUNT_LIMIT },
  { id: "1tb", quotaBytes: 1024 * GIB, fileCountLimit: STORAGE_PAID_FILE_COUNT_LIMIT },
];

export type StorageQuota = {
  tier: StorageTierId | null;
  quotaBytes: number;
  fileCountLimit: number;
};

export function isStorageTierId(value: unknown): value is StorageTierId {
  return (
    typeof value === "string" &&
    (STORAGE_TIER_IDS as readonly string[]).includes(value)
  );
}

export function storageTierOf(id: StorageTierId): StorageTier {
  const tier = STORAGE_PLAN_TIERS.find((candidate) => candidate.id === id);
  if (!tier) {
    throw new RangeError(`Unknown storage tier: ${id}`);
  }
  return tier;
}

// null は無料枠。知らない文字列も無料枠に落とす (取引内で throw しない)。
export function storageQuotaFor(tier: string | null): StorageQuota {
  if (!isStorageTierId(tier)) {
    return {
      tier: null,
      quotaBytes: STORAGE_FREE_QUOTA_BYTES,
      fileCountLimit: STORAGE_FREE_FILE_COUNT_LIMIT,
    };
  }
  const definition = storageTierOf(tier);
  return {
    tier,
    quotaBytes: definition.quotaBytes,
    fileCountLimit: definition.fileCountLimit,
  };
}

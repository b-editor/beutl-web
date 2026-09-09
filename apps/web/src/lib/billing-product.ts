import type { StorageTierId } from "@beutl/core";

// 契約できる商品の種別。AI Pro とストレージプランは別々の Stripe 契約。
export type BillingProduct = "aiPro" | "storage";

type Translate = (key: string, options?: Record<string, unknown>) => string;

// 製品名とティア名は別々の語として持つ。請求まわりでは「Beutl AI: Pro」と
// 繋げて出すが、履歴の明細や将来のティア追加では片方だけを使う場面がある。
const PRODUCT_LABEL_KEYS: Record<
  BillingProduct,
  { product: string; tier: string | null }
> = {
  aiPro: {
    product: "account:billing.productName",
    tier: "account:billing.tierPro",
  },
  storage: {
    product: "account:billing.storageProductName",
    tier: null,
  },
};

export function storageTierLabelKey(tier: StorageTierId): string {
  return `account:billing.storageTier.${tier}`;
}

export function formatBillingProductLabel(
  t: Translate,
  product: BillingProduct,
  options: { tier?: StorageTierId | null } = {},
): string {
  const keys = PRODUCT_LABEL_KEYS[product];
  const tierKey =
    product === "storage"
      ? options.tier
        ? storageTierLabelKey(options.tier)
        : null
      : keys.tier;
  if (!tierKey) {
    return t(keys.product);
  }
  return t("account:billing.productTier", {
    product: t(keys.product),
    tier: t(tierKey),
  });
}

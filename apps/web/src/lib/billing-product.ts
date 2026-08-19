// 契約できる商品の種別。1ユーザー複数契約に対応したらここに値が増える。
export type BillingProduct = "aiPro";

type Translate = (key: string, options?: Record<string, unknown>) => string;

// 製品名とティア名は別々の語として持つ。請求まわりでは「Beutl AI: Pro」と
// 繋げて出すが、履歴の明細や将来のティア追加では片方だけを使う場面がある。
const PRODUCT_LABEL_KEYS: Record<
  BillingProduct,
  { product: string; tier: string }
> = {
  aiPro: {
    product: "account:billing.productName",
    tier: "account:billing.tierPro",
  },
};

export function formatBillingProductLabel(
  t: Translate,
  product: BillingProduct,
): string {
  const keys = PRODUCT_LABEL_KEYS[product];
  return t("account:billing.productTier", {
    product: t(keys.product),
    tier: t(keys.tier),
  });
}

import "server-only";

import { getEntitlements } from "@beutl/api";
import {
  findCustomerByUserId,
  findPackagesForBillingHistory,
  getCreditPurchasesByUserId,
  getDb,
  getUserPaymentHistory,
} from "@beutl/db";
import {
  getAiPlanPresentation,
  type AiPlanStatusPresentation,
} from "@/lib/ai-plan-presentation";

// 契約できる商品の種別。1ユーザー複数契約に対応したらここに値が増える。
export type BillingProduct = "aiPro";

export type BillingSubscriptionEntry = {
  product: BillingProduct;
  status: AiPlanStatusPresentation;
  // 表示すべきでないときは null。
  currentPeriodEnd: string | null;
  showCancellationNotice: boolean;
};

// まだ契約していない商品。契約中のものは含まない。
export type BillingOfferEntry = { product: BillingProduct };

export async function retrieveBillingPage(userId: string) {
  // getDb() は Hyperdrive の maxUses:1 に合わせて呼ぶたび新しい接続を張るため、
  // 複数のクエリで 1 つのクライアントを共有する。getEntitlements は prisma を
  // 受け取らず自前でトランザクションを開くので、これだけは別接続になる。
  const prisma = await getDb();
  const [entitlements, customer, payments, creditPurchases] = await Promise.all(
    [
      getEntitlements(userId),
      findCustomerByUserId({ userId, prisma }),
      getUserPaymentHistory({ userId, prisma }),
      getCreditPurchasesByUserId({ userId, prisma }),
    ],
  );
  const packagesById = await findPackagesForBillingHistory({
    packageIds: payments.map((payment) => payment.packageId),
    prisma,
  });

  const presentation = getAiPlanPresentation(entitlements);
  // 契約中の商品と加入できる商品を配列で返す。今日の商品は AI Pro だけなので
  // どちらも 0〜1 件だが、商品が増えたらここに写像を足して連結する。
  const subscriptions: BillingSubscriptionEntry[] =
    presentation.canManageSubscription
      ? [
          {
            product: "aiPro",
            status: presentation.status,
            currentPeriodEnd: presentation.showCurrentPeriodEnd
              ? entitlements.currentPeriodEnd
              : null,
            showCancellationNotice: presentation.showCancellationNotice,
          },
        ]
      : [];
  const offers: BillingOfferEntry[] = presentation.canManageSubscription
    ? []
    : [{ product: "aiPro" }];

  return {
    subscriptions,
    offers,
    aiUsage: {
      canUseAi: entitlements.canUseAi,
      ...entitlements.balance,
    },
    // 支払い方法カードのボタンを出すかどうかの判断にだけ使う。
    hasStripeCustomer: customer !== null,
    payments,
    creditPurchases,
    packagesById,
  };
}

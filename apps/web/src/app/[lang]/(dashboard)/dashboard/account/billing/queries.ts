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
import type { BillingProduct } from "@/lib/billing-product";
import {
  retrieveBillingDocuments,
  type BillingDocuments,
} from "@/lib/stripe/billing-documents";
import { createStripe } from "@/lib/stripe/config";

export type BillingSubscriptionEntry = {
  product: BillingProduct;
  status: AiPlanStatusPresentation;
  // 表示すべきでないときは null。
  currentPeriodEnd: string | null;
  showCancellationNotice: boolean;
};

// まだ契約していない商品。契約中のものは含まない。
export type BillingOfferEntry = { product: BillingProduct };

const NO_BILLING_DOCUMENTS: BillingDocuments = {
  subscriptionPayments: [],
  documentByPaymentIntentId: new Map(),
};

// サブスクリプションの支払いと書類のリンクは Stripe にしかない。読めなかったときは
// DB だけで組める分の履歴を出し、欠けていることを呼び出し側に知らせる。
async function retrieveBillingDocumentsIfReachable({
  stripeCustomerId,
  userId,
}: {
  stripeCustomerId: string | null;
  userId: string;
}): Promise<{ documents: BillingDocuments; unavailable: boolean }> {
  if (!stripeCustomerId) {
    return { documents: NO_BILLING_DOCUMENTS, unavailable: false };
  }
  try {
    const documents = await retrieveBillingDocuments({
      stripe: createStripe(),
      customerId: stripeCustomerId,
      userId,
    });
    return { documents, unavailable: false };
  } catch (error) {
    console.error("Could not read the billing documents from Stripe", error);
    return { documents: NO_BILLING_DOCUMENTS, unavailable: true };
  }
}

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
  const [packagesById, billingDocuments] = await Promise.all([
    findPackagesForBillingHistory({
      packageIds: payments.map((payment) => payment.packageId),
      prisma,
    }),
    retrieveBillingDocumentsIfReachable({
      stripeCustomerId: customer?.stripeId ?? null,
      userId,
    }),
  ]);

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
    // 支払い方法がまだ 1 つも無いことの目安。顧客が無ければ確実に無い。
    hasStripeCustomer: customer !== null,
    payments,
    creditPurchases,
    packagesById,
    subscriptionPayments: billingDocuments.documents.subscriptionPayments,
    documentByPaymentIntentId:
      billingDocuments.documents.documentByPaymentIntentId,
    billingDocumentsUnavailable: billingDocuments.unavailable,
  };
}

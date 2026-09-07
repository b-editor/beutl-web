import "server-only";

import { getEntitlementSummary } from "@beutl/api/ai/entitlements";
import {
  STORAGE_TIER_IDS,
  effectiveSubscriptionEnd,
  type StorageTierId,
} from "@beutl/core";
import {
  findCustomerByUserId,
  findPackagesForBillingHistory,
  getCreditPurchasesByUserId,
  getDb,
  getUserPaymentHistory,
  resolveStorageQuota,
} from "@beutl/db";
import {
  getAiPlanPresentation,
  type AiPlanStatusPresentation,
} from "@/lib/ai-plan-presentation";
import type { BillingProduct } from "@/lib/billing-product";
import { getSubscriptionPresentation } from "@/lib/subscription-presentation";
import {
  retrieveBillingDocuments,
  type BillingDocuments,
} from "@/lib/stripe/billing-documents";
import { createStripe } from "@/lib/stripe/config";

export type BillingSubscriptionEntry = {
  product: BillingProduct;
  // ストレージ契約だけ持つ。
  tier: StorageTierId | null;
  status: AiPlanStatusPresentation;
  // 表示すべきでないときは null。
  currentPeriodEnd: string | null;
  showCancellationNotice: boolean;
};

// まだ契約していない商品。契約中のものは含まない。ストレージは加入できる
// ティアを並べる。
export type BillingOfferEntry =
  | { product: "aiPro" }
  | { product: "storage"; tiers: readonly StorageTierId[] };

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
  // Explicitly share the render-scoped PrismaClient across all billing reads.
  const prisma = await getDb();
  const [entitlements, customer, payments, creditPurchases, storageQuota] =
    await Promise.all([
      getEntitlementSummary(userId, { prisma }),
      findCustomerByUserId({ userId, prisma }),
      getUserPaymentHistory({ userId, prisma }),
      getCreditPurchasesByUserId({ userId, prisma }),
      resolveStorageQuota({ userId, prisma }),
    ]);
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
  const storageSubscription = storageQuota.subscription;
  const storageEnd = storageSubscription
    ? effectiveSubscriptionEnd(storageSubscription)
    : null;
  const storagePresentation = getSubscriptionPresentation({
    entitled: storageQuota.tier !== null,
    subscriptionStatus: storageSubscription?.status ?? null,
    cancelAtPeriodEnd: storageSubscription?.cancelAtPeriodEnd === true,
    currentPeriodEnd: storageEnd ? storageEnd.toISOString() : null,
  });
  // 契約中の商品と加入できる商品を配列で返す。商品ごとに片方にだけ入る。
  const subscriptions: BillingSubscriptionEntry[] = [];
  const offers: BillingOfferEntry[] = [];
  if (presentation.canManageSubscription) {
    subscriptions.push({
      product: "aiPro",
      tier: null,
      status: presentation.status,
      currentPeriodEnd: presentation.showCurrentPeriodEnd
        ? entitlements.currentPeriodEnd
        : null,
      showCancellationNotice: presentation.showCancellationNotice,
    });
  } else {
    offers.push({ product: "aiPro" });
  }
  if (storagePresentation.canManageSubscription && storageSubscription) {
    subscriptions.push({
      product: "storage",
      tier: storageQuota.tier ?? null,
      status: storagePresentation.status,
      currentPeriodEnd:
        storagePresentation.showCurrentPeriodEnd && storageEnd
          ? storageEnd.toISOString()
          : null,
      showCancellationNotice: storagePresentation.showCancellationNotice,
    });
  } else {
    offers.push({ product: "storage", tiers: STORAGE_TIER_IDS });
  }

  return {
    subscriptions,
    offers,
    aiUsage: {
      canUseAi: entitlements.canUseAi,
      ...entitlements.balance,
    },
    storageQuota: {
      tier: storageQuota.tier,
      quotaBytes: storageQuota.quotaBytes,
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

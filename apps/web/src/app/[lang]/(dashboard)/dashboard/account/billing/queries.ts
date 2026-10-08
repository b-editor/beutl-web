import "server-only";

import { getEntitlementSummary } from "@beutl/api/ai/entitlements";
import {
  STORAGE_TIER_IDS,
  effectiveSubscriptionEnd,
  isActiveSubscription,
  isStorageTierId,
  type StorageTierId,
  type SubscriptionPlanId,
} from "@beutl/core";
import {
  findCustomerByUserId,
  findPackagesForBillingHistory,
  getCreditPurchasesByUserId,
  getDb,
  getSubscription,
  getUserPaymentHistory,
  resolveStorageQuota,
} from "@beutl/db";
import {
  getAiPlanPresentation,
  type AiPlanStatusPresentation,
} from "@/lib/ai-plan-presentation";
import type { BillingProduct } from "@/lib/billing-product";
import {
  getSubscriptionPresentation,
  type SubscriptionPresentation,
} from "@/lib/subscription-presentation";
import {
  retrieveBillingDocuments,
  type BillingDocuments,
} from "@/lib/stripe/billing-documents";
import { createStripe } from "@/lib/stripe/config";
import {
  describeConfiguredSubscriptionPrices,
  type SubscriptionPriceDescription,
} from "@/lib/stripe/subscription-billing";
import { subscriptionPlanConfig } from "@/lib/stripe/subscription-plans";

// granted は管理者の付与。請求も Stripe での管理も無い。
export type BillingSubscriptionStatus = AiPlanStatusPresentation | "granted";

export type BillingSubscriptionEntry = {
  product: BillingProduct;
  // ストレージ契約だけ持つ。
  tier: StorageTierId | null;
  status: BillingSubscriptionStatus;
  // 表示すべきでないときは null。付与 (granted) では付与の終了で、null は無期限。
  currentPeriodEnd: string | null;
  showCancellationNotice: boolean;
};

// まだ契約していない商品。契約中のものは含まない。ストレージは加入できる
// ティアを並べる。
export type BillingOfferEntry =
  | { product: "aiPro" }
  | { product: "storage"; tiers: readonly StorageTierId[] };

// 月額。null は価格を取得できなかったティア (env 未設定や Stripe 不達)。
export type StorageTierPrices = Record<
  StorageTierId,
  SubscriptionPriceDescription | null
>;

// A tier change is charged right away without a Checkout page, so the page
// must be able to show what each tier costs before offering the change.
async function retrieveStorageTierPrices(): Promise<StorageTierPrices> {
  const described = await describeConfiguredSubscriptionPrices(
    subscriptionPlanConfig("storage"),
    createStripe(),
  );
  return Object.fromEntries(
    STORAGE_TIER_IDS.map((tier) => [tier, described.get(tier) ?? null]),
  ) as StorageTierPrices;
}

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

type StoredSubscription = NonNullable<Awaited<ReturnType<typeof getSubscription>>>;

// Stripe の契約だけから組んだ見え方。付与が権利を与えている間は、権利の有無も
// Stripe の契約だけで決める (付与の分を足すと、支払いに失敗した契約が有効に見える)。
function stripeOnlyPresentation(
  subscription: StoredSubscription,
  planId: SubscriptionPlanId,
): { presentation: SubscriptionPresentation; end: Date | null } {
  const end = effectiveSubscriptionEnd(subscription);
  return {
    end,
    presentation: getSubscriptionPresentation({
      entitled: isActiveSubscription(subscription, planId),
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodEnd: end ? end.toISOString() : null,
    }),
  };
}

function stripeSubscriptionEntry(
  product: BillingProduct,
  tier: StorageTierId | null,
  { presentation, end }: { presentation: SubscriptionPresentation; end: Date | null },
): BillingSubscriptionEntry {
  return {
    product,
    tier,
    status: presentation.status,
    currentPeriodEnd:
      presentation.showCurrentPeriodEnd && end ? end.toISOString() : null,
    showCancellationNotice: presentation.showCancellationNotice,
  };
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
  const storageSubscription = storageQuota.subscription;
  const [
    packagesById,
    billingDocuments,
    storageTierPrices,
    aiStripeBehindGrant,
    storageStripeBehindGrant,
  ] = await Promise.all([
    findPackagesForBillingHistory({
      packageIds: payments.map((payment) => payment.packageId),
      prisma,
    }),
    retrieveBillingDocumentsIfReachable({
      stripeCustomerId: customer?.stripeId ?? null,
      userId,
    }),
    retrieveStorageTierPrices(),
    // 付与が権利を与えていても、Stripe の契約が残っていることがある (付与の後に
    // 古い画面から加入し、その支払いに失敗したなど)。直すべき契約を付与で隠さない
    // よう、付与が効いているときだけその陰の Stripe の契約を読む。
    entitlements.grant ? getSubscription({ userId, planId: "pro", prisma }) : null,
    storageSubscription?.source === "grant"
      ? getSubscription({ userId, planId: "storage", prisma })
      : null,
  ]);

  const presentation = getAiPlanPresentation(entitlements);
  const aiStripe = aiStripeBehindGrant
    ? stripeOnlyPresentation(aiStripeBehindGrant, "pro")
    : null;
  const storageStripe = storageStripeBehindGrant
    ? stripeOnlyPresentation(storageStripeBehindGrant, "storage")
    : null;
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
  // 付与が権利を与えているのは Stripe の契約が与えていない間だけ。その陰に管理の
  // 要る Stripe の契約があればそちらを出し (支払いの確認や解約ができるように)、
  // 無ければ付与を出す。どちらの場合も加入の案内は出さない (付与が終われば出る)。
  if (aiStripe?.presentation.canManageSubscription) {
    subscriptions.push(stripeSubscriptionEntry("aiPro", null, aiStripe));
  } else if (entitlements.grant) {
    subscriptions.push({
      product: "aiPro",
      tier: null,
      status: "granted",
      currentPeriodEnd: entitlements.grant.endsAt,
      showCancellationNotice: false,
    });
  } else if (presentation.canManageSubscription) {
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
  if (storageStripeBehindGrant && storageStripe?.presentation.canManageSubscription) {
    subscriptions.push(
      stripeSubscriptionEntry(
        "storage",
        isStorageTierId(storageStripeBehindGrant.tier) ? storageStripeBehindGrant.tier : null,
        storageStripe,
      ),
    );
  } else if (storageSubscription?.source === "grant") {
    subscriptions.push({
      product: "storage",
      tier: isStorageTierId(storageSubscription.tier) ? storageSubscription.tier : null,
      status: "granted",
      currentPeriodEnd: storageSubscription.grant.endsAt?.toISOString() ?? null,
      showCancellationNotice: false,
    });
  } else if (storagePresentation.canManageSubscription && storageSubscription) {
    subscriptions.push({
      product: "storage",
      // The tier the customer subscribed to, whether or not it is granting
      // anything right now (past_due, a refund hold). The effective quota is
      // reported separately in storageQuota.
      tier: isStorageTierId(storageSubscription.tier) ? storageSubscription.tier : null,
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
    storageTierPrices,
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

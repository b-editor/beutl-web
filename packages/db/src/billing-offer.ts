import { isSubscriptionTier, subscriptionPlanOfOfferKind } from "@beutl/core";
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export type BillingOfferKind = "pro" | "top_up" | "storage";

export type BillingOfferTerms = {
  kind: BillingOfferKind;
  stripePriceId: string;
  stripeProductId: string;
  unitAmount: number;
  currency: string;
  creditAmount: number | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  // ティアを持つプランの Price だけに入る。省略は null と同じ。
  tier?: string | null;
};

function normalizeTerms(terms: BillingOfferTerms): BillingOfferTerms {
  if (!Number.isSafeInteger(terms.unitAmount) || terms.unitAmount <= 0) {
    throw new RangeError("Billing offer unitAmount must be a positive integer");
  }
  if (terms.stripePriceId.trim().length === 0) {
    throw new RangeError("Billing offer stripePriceId must not be empty");
  }
  if (terms.stripeProductId.trim().length === 0) {
    throw new RangeError("Billing offer stripeProductId must not be empty");
  }
  const currency = terms.currency.toLowerCase();
  if (currency.length === 0) {
    throw new RangeError("Billing offer currency must not be empty");
  }
  if (
    terms.kind === "top_up" &&
    (!Number.isSafeInteger(terms.creditAmount) ||
      (terms.creditAmount ?? 0) <= 0 ||
      terms.recurringInterval !== null ||
      terms.recurringIntervalCount !== null)
  ) {
    throw new Error("A top-up billing offer must be a positive one-time Price");
  }
  const tier = terms.tier ?? null;
  const plan = subscriptionPlanOfOfferKind(terms.kind);
  if (plan) {
    // サブスクリプションの offer は月次 1 回。ティアの集合はプランの定義が決める:
    // ティアを持つプランは既知のティアが必須、持たないプランは null だけ。
    if (
      terms.creditAmount !== null ||
      terms.recurringInterval !== "month" ||
      terms.recurringIntervalCount !== 1
    ) {
      throw new Error(`A ${plan.id} billing offer must be a monthly recurring Price`);
    }
    if (!isSubscriptionTier(plan, tier)) {
      throw new Error(
        plan.tierIds.length === 0
          ? `A ${plan.id} billing offer has no tiers`
          : `A ${plan.id} billing offer must name a known tier`,
      );
    }
  } else if (tier !== null) {
    throw new Error("Only a subscription billing offer can carry a tier");
  }
  return { ...terms, currency, tier };
}

function assertSameTerms(
  stored: BillingOfferTerms,
  incoming: BillingOfferTerms,
): void {
  for (const key of [
    "kind",
    "stripePriceId",
    "stripeProductId",
    "unitAmount",
    "currency",
    "creditAmount",
    "recurringInterval",
    "recurringIntervalCount",
  ] as const) {
    if (stored[key] !== incoming[key]) {
      throw new Error(
        `Stripe Price ${incoming.stripePriceId} conflicts with its persisted billing offer`,
      );
    }
  }
  // 既存の Pro / top-up 行は列が NULL で、条件側は省略されている。どちらも「無し」。
  if ((stored.tier ?? null) !== (incoming.tier ?? null)) {
    throw new Error(
      `Stripe Price ${incoming.stripePriceId} conflicts with its persisted billing offer`,
    );
  }
}

// Activating a checkout offer retires only the checkout pointer. Historical
// rows and their immutable terms remain available to renewals and reversals.
export async function activateBillingOffer({
  terms: rawTerms,
  prisma,
}: {
  terms: BillingOfferTerms;
  prisma?: PrismaTransaction;
}) {
  const terms = normalizeTerms(rawTerms);
  const run = async (tx: PrismaTransaction) => {
    let offer = await tx.billingOffer.upsert({
      where: { stripePriceId: terms.stripePriceId },
      create: { ...terms, checkoutEnabled: false },
      update: {},
    });
    assertSameTerms(offer as BillingOfferTerms, terms);

    // 「販売中の offer は kind とティアごとに 1 つ」。ティアの無い kind では
    // tier が null 同士なので、従来どおり kind ごとに 1 つになる。
    await tx.billingOffer.updateMany({
      where: {
        kind: terms.kind,
        tier: terms.tier ?? null,
        checkoutEnabled: true,
        id: { not: offer.id },
      },
      data: { checkoutEnabled: false },
    });
    if (!offer.checkoutEnabled) {
      offer = await tx.billingOffer.update({
        where: { id: offer.id },
        data: { checkoutEnabled: true },
      });
    }
    return offer;
  };

  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

// Ownership must be verified by the caller before invoking this function.
// Unlike activation, historical registration never changes the checkout
// pointer and therefore cannot revive an archived Stripe Price for new sales.
export async function registerHistoricalBillingOffer({
  terms: rawTerms,
  ownershipVerified,
  prisma,
}: {
  terms: BillingOfferTerms;
  ownershipVerified: true;
  prisma?: PrismaTransaction;
}) {
  if (ownershipVerified !== true) {
    throw new Error("Historical billing offer ownership must be verified");
  }
  const terms = normalizeTerms(rawTerms);
  const run = async (tx: PrismaTransaction) => {
    const offer = await tx.billingOffer.upsert({
      where: { stripePriceId: terms.stripePriceId },
      create: { ...terms, checkoutEnabled: false },
      update: {},
    });
    assertSameTerms(offer as BillingOfferTerms, terms);
    return offer;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function findBillingOfferById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.billingOffer.findUnique({ where: { id } });
}

export async function findBillingOfferByStripePriceId({
  stripePriceId,
  prisma,
}: {
  stripePriceId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.billingOffer.findUnique({ where: { stripePriceId } });
}

// The offer new purchases are made against. "One row per kind" is enforced
// inside activateBillingOffer's transaction rather than by a unique index, so a
// rotation interrupted midway could leave two rows enabled. Order the result so
// the caller always sees the same one.
export async function findCheckoutBillingOffer({
  kind,
  tier,
  prisma,
}: {
  kind: BillingOfferKind;
  tier?: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.billingOffer.findFirst({
    where: {
      kind,
      checkoutEnabled: true,
      ...(tier !== undefined ? { tier } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

export async function listBillingOfferPriceIds({
  kind,
  tier,
  prisma,
}: {
  kind: BillingOfferKind;
  tier?: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const offers = await db.billingOffer.findMany({
    where: { kind, ...(tier !== undefined ? { tier } : {}) },
    select: { stripePriceId: true },
  });
  return offers.map((offer) => offer.stripePriceId);
}

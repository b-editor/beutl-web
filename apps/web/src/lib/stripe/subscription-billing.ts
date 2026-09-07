// Stripe の契約と BillingOffer の対応付け。どのプランでも同じ規則:
// - 権利を与えられる Price は env に明示されたもの (現行 + 履歴) だけ。
// - offer を Stripe から記録してよいのは、契約の所有が確かめられた経路だけ。
// - ティアの正は Price から解決した BillingOffer.tier で、metadata.tier は参考情報。
import {
  activateBillingOffer,
  findBillingOfferByStripePriceId,
  registerHistoricalBillingOffer,
  type BillingOfferTerms,
} from "@beutl/db";
import type Stripe from "stripe";
import { getExpandableId } from "./ownership";
import {
  configuredPriceOf,
  subscriptionPlanConfigOf,
  type SubscriptionPlanConfig,
} from "./subscription-plans";

export type SubscriptionOfferRecord = BillingOfferTerms & {
  id: string;
  checkoutEnabled: boolean;
  tier: string | null;
};

// The row as Prisma returns it: `kind` is a plain string in the database.
type PersistedOfferRow = Omit<BillingOfferTerms, "kind" | "tier"> & {
  id: string;
  kind: string;
  tier: string | null;
  checkoutEnabled: boolean;
};

function asPlanOffer(
  plan: SubscriptionPlanConfig,
  offer: PersistedOfferRow,
): SubscriptionOfferRecord | null {
  if (offer.kind !== plan.offerKind) return null;
  return { ...offer, kind: plan.offerKind, tier: offer.tier ?? null };
}

export function subscriptionTermsFromPrice(
  plan: SubscriptionPlanConfig,
  price: Stripe.Price,
  tier: string | null,
  requireActive: boolean,
): BillingOfferTerms {
  const stripeProductId = getExpandableId(price.product);
  if (
    (requireActive && !price.active) ||
    price.unit_amount === null ||
    !stripeProductId
  ) {
    throw new Error(
      `Stripe Price ${price.id} is not a valid fixed-price billing offer`,
    );
  }
  if (
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error(
      `${plan.priceEnvName(tier)} must identify a monthly recurring Price`,
    );
  }
  return {
    kind: plan.offerKind,
    stripePriceId: price.id,
    stripeProductId,
    unitAmount: price.unit_amount,
    currency: price.currency,
    creditAmount: null,
    recurringInterval: "month",
    recurringIntervalCount: 1,
    tier,
  };
}

// 現行の Price を読んで販売用 offer として記録する。チェックアウトの入口。
export async function activateConfiguredSubscriptionOffer(
  plan: SubscriptionPlanConfig,
  stripe: Stripe,
  tier: string | null,
): Promise<SubscriptionOfferRecord> {
  const priceId = plan.currentPriceId(tier);
  if (!priceId) {
    throw new Error(`${plan.priceEnvName(tier)} is not set`);
  }
  const price = await stripe.prices.retrieve(priceId);
  const offer = asPlanOffer(
    plan,
    await activateBillingOffer({
      terms: subscriptionTermsFromPrice(plan, price, tier, true),
    }),
  );
  if (!offer) {
    throw new Error(`Stripe Price ${priceId} did not persist as a ${plan.id} offer`);
  }
  return offer;
}

export function subscriptionPlanFromStripe(
  subscription: Pick<Stripe.Subscription, "metadata">,
): SubscriptionPlanConfig | null {
  return subscriptionPlanConfigOf(subscription.metadata?.planId);
}

export function isSubscriptionForOffer(
  plan: Pick<SubscriptionPlanConfig, "offerKind">,
  subscription: Stripe.Subscription,
  offer: Pick<
    SubscriptionOfferRecord,
    | "id"
    | "kind"
    | "stripePriceId"
    | "stripeProductId"
    | "unitAmount"
    | "currency"
    | "recurringInterval"
    | "recurringIntervalCount"
  >,
): boolean {
  if (offer.kind !== plan.offerKind || subscription.items.data.length !== 1) {
    return false;
  }
  const item = subscription.items.data[0];
  const metadataOfferId = subscription.metadata?.billingOfferId;
  return (
    (!metadataOfferId || metadataOfferId === offer.id) &&
    item.price.id === offer.stripePriceId &&
    getExpandableId(item.price.product) === offer.stripeProductId &&
    item.price.unit_amount === offer.unitAmount &&
    item.price.currency.toLowerCase() === offer.currency.toLowerCase() &&
    item.quantity === 1 &&
    item.price.recurring?.interval === offer.recurringInterval &&
    item.price.recurring.interval_count === offer.recurringIntervalCount
  );
}

// 既に記録されている offer だけで解決する (Stripe は読まない)。
export async function resolvePersistedSubscriptionOffer(
  plan: SubscriptionPlanConfig,
  subscription: Stripe.Subscription,
): Promise<SubscriptionOfferRecord | null> {
  if (
    subscription.items.data.length !== 1 ||
    subscription.metadata?.planId !== plan.id
  ) {
    return null;
  }
  const item = subscription.items.data[0];
  const stripePriceId = item.price.id;
  const configured = configuredPriceOf(plan, stripePriceId);
  if (!configured) return null;
  if (
    !configured.isCurrent &&
    getExpandableId(item.price.product) !== configured.historicalProductId
  ) {
    return null;
  }
  const persisted = await findBillingOfferByStripePriceId({ stripePriceId });
  if (!persisted) return null;
  const offer = asPlanOffer(plan, persisted);
  if (!offer || offer.tier !== configured.tier) return null;
  return isSubscriptionForOffer(plan, subscription, offer) ? offer : null;
}

// 既存の Stripe 契約から offer を記録してよい唯一の経路。呼び出し側は先に、
// この契約が Beutl のユーザーのものだと確かめていること。履歴の Price は
// Stripe 上で有効でも販売不可として記録する。
export async function resolveSubscriptionOffer(
  plan: SubscriptionPlanConfig,
  stripe: Stripe,
  subscription: Stripe.Subscription,
  proof: { ownershipVerified: true },
): Promise<SubscriptionOfferRecord | null> {
  if (proof.ownershipVerified !== true) {
    throw new Error("Stripe subscription ownership must be verified");
  }
  if (
    subscription.items.data.length !== 1 ||
    subscription.metadata?.planId !== plan.id
  ) {
    return null;
  }
  const stripePriceId = subscription.items.data[0].price.id;
  const configured = configuredPriceOf(plan, stripePriceId);
  if (!configured) return null;

  const persisted = await resolvePersistedSubscriptionOffer(plan, subscription);
  if (
    persisted &&
    (configured.isCurrent ||
      persisted.stripeProductId === configured.historicalProductId)
  ) {
    return persisted;
  }
  const price = await stripe.prices.retrieve(stripePriceId);
  if (
    configured.isCurrent
      ? !price.active
      : getExpandableId(price.product) !== configured.historicalProductId
  ) {
    return null;
  }
  const recorded = configured.isCurrent
    ? await activateBillingOffer({
        terms: subscriptionTermsFromPrice(plan, price, configured.tier, true),
      })
    : await registerHistoricalBillingOffer({
        terms: subscriptionTermsFromPrice(plan, price, configured.tier, false),
        ownershipVerified: proof.ownershipVerified,
      });
  const offer = asPlanOffer(plan, recorded);
  return offer && isSubscriptionForOffer(plan, subscription, offer) ? offer : null;
}

// このプランの終わっていない契約があれば、新しいチェックアウトを始めさせない。
// Price の集合で見るので、他のプランの契約は対象外。
export function blocksNewSubscriptionCheckout(
  subscription: Stripe.Subscription,
  recognizedPriceIds: ReadonlySet<string>,
): boolean {
  const item = subscription.items.data[0];
  return (
    subscription.items.data.length === 1 &&
    item.quantity === 1 &&
    recognizedPriceIds.has(item.price.id) &&
    item.price.recurring?.interval === "month" &&
    item.price.recurring.interval_count === 1 &&
    subscription.status !== "canceled" &&
    subscription.status !== "incomplete_expired"
  );
}

export type SubscriptionPriceDescription = {
  unitAmount: number;
  currency: string;
};

// What each tier of a plan costs, for showing before a change that is charged
// without a Checkout page. The recorded offer is preferred; a Price that has
// never been sold yet is read from Stripe without being recorded. A tier
// whose Price cannot be described maps to null, and the caller decides what
// that means for the action it is offering.
export async function describeConfiguredSubscriptionPrices(
  plan: SubscriptionPlanConfig,
  stripe: Stripe,
): Promise<ReadonlyMap<string | null, SubscriptionPriceDescription | null>> {
  const tiers: Array<string | null> =
    plan.tierIds.length > 0 ? [...plan.tierIds] : [null];
  const entries = await Promise.all(
    tiers.map(async (tier): Promise<[string | null, SubscriptionPriceDescription | null]> => {
      const priceId = plan.currentPriceId(tier);
      if (!priceId) return [tier, null];
      try {
        const persisted = await findBillingOfferByStripePriceId({
          stripePriceId: priceId,
        });
        const offer = persisted ? asPlanOffer(plan, persisted) : null;
        if (offer && offer.tier === tier) {
          return [tier, { unitAmount: offer.unitAmount, currency: offer.currency }];
        }
        const price = await stripe.prices.retrieve(priceId);
        const terms = subscriptionTermsFromPrice(plan, price, tier, false);
        return [tier, { unitAmount: terms.unitAmount, currency: terms.currency }];
      } catch (error) {
        console.error(`Could not describe the ${plan.id} Price for tier ${tier}`, error);
        return [tier, null];
      }
    }),
  );
  return new Map(entries);
}

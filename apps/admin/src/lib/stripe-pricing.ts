import "server-only";
import {
  findCheckoutBillingOffer,
  type BillingOfferKind,
  type PrismaTransaction,
} from "@beutl/db";
import { AI_TOP_UP, readBoundedResponseText } from "@beutl/api";

// Where the money side of the settings page gets its prices.
//
// Stripe is the authority. BillingOffer only holds what a checkout has already
// been created against, so a newly configured price — or one that has never
// been sold — is absent from the database entirely; reading Stripe means the
// page works before the first sale, and shows the current price rather than
// the one in force when the last purchase happened.
//
// The Stripe SDK is not used here. One authenticated GET does not justify the
// dependency, and adding it shifted pnpm's peer resolution enough to detach
// the generated Prisma Client from this app.
//
// The key only needs `prices: read`. Configure a Stripe restricted key rather
// than the full secret key: this Worker has no reason to be able to move money.
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const PRICE_ID_ENV: Record<BillingOfferKind, string> = {
  pro: "STRIPE_PRO_PRICE_ID",
  top_up: "STRIPE_CREDIT_PRICE_ID",
};

// Only the fields this page needs are read, and a tiered or metered price —
// which has no single unit_amount — is rejected rather than guessed at. The
// recurrence comes back too: an amount means nothing here without the period it
// covers.
function parseStripePrice(value: unknown): {
  id: string;
  unitAmount: number;
  currency: string;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
} | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { id, currency, unit_amount: unitAmount, recurring } = record;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof currency !== "string" || currency.length === 0) return null;
  if (typeof unitAmount !== "number" || !Number.isFinite(unitAmount)) {
    return null;
  }
  if (recurring === null || recurring === undefined) {
    return {
      id,
      unitAmount,
      currency,
      recurringInterval: null,
      recurringIntervalCount: null,
    };
  }
  if (typeof recurring !== "object") return null;
  const { interval, interval_count: intervalCount } = recurring as Record<
    string,
    unknown
  >;
  if (typeof interval !== "string" || interval.length === 0) return null;
  return {
    id,
    unitAmount,
    currency,
    recurringInterval: interval,
    recurringIntervalCount:
      typeof intervalCount === "number" ? intervalCount : null,
  };
}

export type OfferPricing = {
  stripePriceId: string;
  unitAmount: number;
  currency: string;
  // Stripe does not know how many usage units a top-up grants; that is an
  // application constant carried in the checkout metadata.
  creditAmount: number | null;
};

export type OfferPricingSource = "stripe" | "database";

export type OfferPricingUnavailable =
  | "notConfigured"
  | "unavailable"
  | "notFound";

export type OfferPricingResult = {
  kind: BillingOfferKind;
  effective: OfferPricing | null;
  source: OfferPricingSource | null;
  stripeError: OfferPricingUnavailable | null;
  hasDatabaseOffer: boolean;
  // True when Stripe and the stored offer disagree, which means the price was
  // edited in Stripe after the offer was recorded. Purchases still settle
  // against the stored terms, so the difference is worth surfacing.
  mismatch: boolean;
};

async function fetchStripePrice(
  kind: BillingOfferKind,
): Promise<
  | { ok: true; pricing: OfferPricing }
  | { ok: false; reason: OfferPricingUnavailable }
> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env[PRICE_ID_ENV[kind]];
  if (!secretKey || !priceId) {
    return { ok: false, reason: "notConfigured" };
  }

  try {
    const response = await fetch(
      `${STRIPE_API_BASE}/prices/${encodeURIComponent(priceId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
      },
    );
    if (response.status === 404) {
      return { ok: false, reason: "notFound" };
    }
    if (!response.ok) {
      throw new Error(`Stripe responded ${response.status}`);
    }
    const body = await readBoundedResponseText(
      response,
      MAX_RESPONSE_BYTES,
      "Stripe price response",
    );
    const price = parseStripePrice(JSON.parse(body));
    if (!price) {
      return { ok: false, reason: "unavailable" };
    }
    if (price.unitAmount <= 0) {
      return { ok: false, reason: "notFound" };
    }
    // The same shape normalizeTerms enforces when the offer is recorded at
    // checkout. Without it a yearly Pro price is read as one month's revenue
    // and divided by the monthly allowance, so the per-unit figure the operator
    // prices against is twelve times what a subscriber actually pays.
    const recurrenceMatches =
      kind === "pro"
        ? price.recurringInterval === "month" &&
          price.recurringIntervalCount === 1
        : price.recurringInterval === null;
    if (!recurrenceMatches) {
      return { ok: false, reason: "notFound" };
    }
    return {
      ok: true,
      pricing: {
        stripePriceId: price.id,
        unitAmount: price.unitAmount,
        currency: price.currency.toLowerCase(),
        creditAmount: kind === "top_up" ? AI_TOP_UP.credits : null,
      },
    };
  } catch (error) {
    // The key must never reach a log line.
    console.warn("[admin-pricing] Stripe price lookup failed", {
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "unavailable" };
  }
}

// Never throws: the settings page has to render with no Stripe credentials and
// no offer recorded.
export async function resolveOfferPricing({
  kind,
  prisma,
}: {
  kind: BillingOfferKind;
  prisma?: PrismaTransaction;
}): Promise<OfferPricingResult> {
  const [stripeResult, storedOffer] = await Promise.all([
    fetchStripePrice(kind),
    findCheckoutBillingOffer({ kind, prisma }),
  ]);

  const stored: OfferPricing | null = storedOffer
    ? {
        stripePriceId: storedOffer.stripePriceId,
        unitAmount: storedOffer.unitAmount,
        currency: storedOffer.currency,
        creditAmount: storedOffer.creditAmount,
      }
    : null;

  if (stripeResult.ok) {
    // The price ID counts as much as the amount: checkout charges the offer's
    // stripePriceId, so an env var rotated to a different price object bills
    // from the old one even when both cost the same.
    const mismatch =
      stored !== null &&
      (stored.unitAmount !== stripeResult.pricing.unitAmount ||
        stored.currency !== stripeResult.pricing.currency ||
        stored.stripePriceId !== stripeResult.pricing.stripePriceId);
    return {
      kind,
      effective: stripeResult.pricing,
      source: "stripe",
      stripeError: null,
      hasDatabaseOffer: stored !== null,
      mismatch,
    };
  }

  return {
    kind,
    effective: stored,
    source: stored ? "database" : null,
    stripeError: stripeResult.reason,
    hasDatabaseOffer: stored !== null,
    mismatch: false,
  };
}

import { hasStripeOwnerMetadata, stripeOwnerMetadata } from "./ownership";
import type Stripe from "stripe";

export const PACKAGE_PURCHASE_METADATA_VALUE = "package";

export function packagePaymentIntentMetadata(
  userId: string,
  packageId: string,
): Record<string, string> {
  return {
    ...stripeOwnerMetadata(userId),
    beutlPurchaseKind: PACKAGE_PURCHASE_METADATA_VALUE,
    packageId,
  };
}

export type PackagePurchaseExpectation = {
  customerId: string;
  userId: string;
  packageId: string;
  amount?: number;
  currency?: string;
};

export const PACKAGE_CHECKOUT_FINGERPRINT_VERSION = "package-checkout-v2";
export const PACKAGE_CHECKOUT_SESSION_EXACT_EXPANDS = ["line_items.data.price.product", "payment_intent"] as const;

export type PackageCheckoutCompletionDecision =
  | "open"
  | "complete-pending"
  | "rotate-terminal";

export function classifyPackageCheckoutCompletion({
  checkoutSession,
  paymentIntent,
  paymentRecord,
}: {
  checkoutSession: Pick<Stripe.Checkout.Session, "status">;
  paymentIntent: Pick<Stripe.PaymentIntent, "status"> | null;
  paymentRecord: { revokedAt: Date | null } | null;
}): PackageCheckoutCompletionDecision {
  if (checkoutSession.status === "open") return "open";
  if (checkoutSession.status !== "complete") return "rotate-terminal";
  if (paymentRecord?.revokedAt) return "rotate-terminal";
  if (paymentIntent?.status === "canceled") return "rotate-terminal";
  // A completed Session with no local payment row is still pending webhook
  // fulfillment. It must return to the completion page, never create a second
  // PaymentIntent.
  return "complete-pending";
}

export async function listAllOpenPackageCheckoutSessions({
  stripe,
  customerId,
  pageSize = 100,
}: {
  stripe: StripeClientLike;
  customerId: string;
  pageSize?: number;
}): Promise<Stripe.Checkout.Session[]> {
  const sessions: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: pageSize,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    sessions.push(...page.data);
    if (!page.has_more) return sessions;
    const last = page.data.at(-1);
    if (!last) throw new Error("Stripe returned an empty Checkout page with has_more");
    startingAfter = last.id;
  }
}

export async function listAllPackageCheckoutSessions({
  stripe,
  customerId,
  pageSize = 100,
}: {
  stripe: StripeClientLike;
  customerId: string;
  pageSize?: number;
}): Promise<Stripe.Checkout.Session[]> {
  const sessions = new Map<string, Stripe.Checkout.Session>();
  for (const status of ["open", "complete", "expired"] as const) {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.checkout.sessions.list({
        customer: customerId,
        status,
        limit: pageSize,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const session of page.data) sessions.set(session.id, session);
      if (!page.has_more) break;
      const last = page.data.at(-1);
      if (!last) throw new Error(`Stripe returned an empty ${status} Checkout page with has_more`);
      startingAfter = last.id;
    }
  }
  return [...sessions.values()];
}

export async function listLegacyCompletePackageCheckoutSessions({ stripe, customerId, userId, packageId, pageSize = 100 }: { stripe: StripeClientLike; customerId: string; userId: string; packageId: string; pageSize?: number }): Promise<Stripe.Checkout.Session[]> {
  const sessions: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.checkout.sessions.list({ customer: customerId, status: "complete", limit: pageSize, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    sessions.push(...page.data.filter((s) => s.mode === "payment" && isOwnedPackageCheckoutCandidate(s, { customerId, userId, packageId })));
    if (!page.has_more) return sessions;
    const last = page.data.at(-1);
    if (!last) throw new Error("Stripe returned an empty complete Checkout page with has_more");
    startingAfter = last.id;
  }
}

type StripeClientLike = {
  checkout: {
    sessions: {
      list: Stripe.Checkout.SessionsResource["list"];
    };
  };
};

export function isOwnedPackageCheckoutCandidate(
  checkoutSession: Pick<Stripe.Checkout.Session, "customer" | "metadata" | "mode">,
  expected: Pick<PackagePurchaseExpectation, "customerId" | "userId" | "packageId">,
): boolean {
  const customerId =
    typeof checkoutSession.customer === "string"
      ? checkoutSession.customer
      : checkoutSession.customer?.id;
  return (
    checkoutSession.mode === "payment" &&
    customerId === expected.customerId &&
    hasPackagePurchaseOwnership(checkoutSession.metadata, expected)
  );
}

export function shouldReuseBoundPackageCheckoutSession({
  attemptFingerprint,
  currentFingerprint,
  checkoutSession,
  expected,
  lang,
  packageName,
}: {
  attemptFingerprint: string;
  currentFingerprint: string;
  checkoutSession: Stripe.Checkout.Session;
  expected: PackagePurchaseExpectation;
  lang: string;
  packageName: string;
}): boolean {
  return (
    attemptFingerprint === currentFingerprint &&
    isOwnedPackageCheckoutSession(checkoutSession, expected) &&
    checkoutSession.success_url?.includes(`/${lang}/store/${packageName}/`) === true
  );
}

export function packageCheckoutFingerprintInput(
  params: Stripe.Checkout.SessionCreateParams,
): unknown {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return value;
  };
  return {
    version: PACKAGE_CHECKOUT_FINGERPRINT_VERSION,
    params: canonicalize(params),
  };
}

function hasPackagePurchaseOwnership(
  metadata: Stripe.Metadata | null,
  { userId, packageId }: Pick<PackagePurchaseExpectation, "userId" | "packageId">,
): boolean {
  return (
    metadata?.beutlPurchaseKind === PACKAGE_PURCHASE_METADATA_VALUE &&
    metadata.packageId === packageId &&
    hasStripeOwnerMetadata(metadata, userId)
  );
}

function matchesPrice(
  actual: { amount: number | null; currency: string | null },
  expected: Pick<PackagePurchaseExpectation, "amount" | "currency">,
): boolean {
  return (
    (expected.amount === undefined || actual.amount === expected.amount) &&
    (expected.currency === undefined ||
      actual.currency?.toLowerCase() === expected.currency.toLowerCase())
  );
}

export function isOwnedPackagePaymentIntent(
  paymentIntent: Pick<
    Stripe.PaymentIntent,
    "amount" | "currency" | "customer" | "metadata"
  >,
  expected: PackagePurchaseExpectation,
): boolean {
  const paymentCustomerId =
    typeof paymentIntent.customer === "string"
      ? paymentIntent.customer
      : paymentIntent.customer?.id;
  return (
    paymentCustomerId === expected.customerId &&
    hasPackagePurchaseOwnership(paymentIntent.metadata, expected) &&
    matchesPrice(
      { amount: paymentIntent.amount, currency: paymentIntent.currency },
      expected,
    )
  );
}

// 未払いの Checkout Session を使い回してよいかの判定。同じ買い物で毎回セッションを
// 作ると、タブを開き直しただけで二重の支払い口ができてしまう。
export function isOwnedPackageCheckoutSession(
  checkoutSession: Pick<
    Stripe.Checkout.Session,
    "amount_total" | "currency" | "customer" | "metadata" | "mode"
  >,
  expected: PackagePurchaseExpectation,
): boolean {
  const sessionCustomerId =
    typeof checkoutSession.customer === "string"
      ? checkoutSession.customer
      : checkoutSession.customer?.id;
  return (
    isOwnedPackageCheckoutCandidate(checkoutSession, expected) &&
    sessionCustomerId === expected.customerId &&
    matchesPrice(
      {
        amount: checkoutSession.amount_total,
        currency: checkoutSession.currency,
      },
      expected,
    )
  );
}

/**
 * A legacy Session is bindable only when Stripe carries the exact durable
 * attempt id. Price/metadata/success-url similarity alone is not an identity
 * proof because response-lost creates and parameter changes can overlap.
 */
export function isDurablyAssociatedPackageCheckoutSession(
  checkoutSession: Pick<Stripe.Checkout.Session, "metadata">,
  attemptId: string,
): boolean {
  return checkoutSession.metadata?.packageCheckoutAttemptId === attemptId;
}

/**
 * Compare the observable fields Stripe retained for a Checkout Session with
 * the persisted create parameters. This deliberately does not require a
 * discovery token: rows created before tokenized attempts may have a durable
 * Session id but neither metadata location contains that token.
 */
export function matchesPersistedPackageCheckoutSession(
  checkoutSession: Stripe.Checkout.Session,
  params: Stripe.Checkout.SessionCreateParams,
  paymentIntent: Stripe.PaymentIntent | null,
): boolean {
  const expectedLine = params.line_items?.[0];
  const expectedPriceData = expectedLine && "price_data" in expectedLine
    ? expectedLine.price_data
    : undefined;
  const actualLine = checkoutSession.line_items?.data;
  const actualPrice = actualLine?.length === 1 && typeof actualLine[0].price === "object"
    ? actualLine[0].price
    : null;
  const actualProduct = actualPrice?.product && typeof actualPrice.product === "object" && !("deleted" in actualPrice.product)
    ? actualPrice.product
    : null;
  const expectedProduct = expectedPriceData?.product_data;
  const productMatches = expectedProduct === undefined
    ? true
    : actualProduct !== null &&
      actualProduct.name === expectedProduct.name &&
      (expectedProduct.description === undefined || actualProduct.description === expectedProduct.description) &&
      JSON.stringify(actualProduct.images ?? []) === JSON.stringify(expectedProduct.images ?? []);
  const metadataMatches = Object.entries(params.metadata ?? {}).every(
    ([key, value]) => checkoutSession.metadata?.[key] === value,
  );
  const expectedPaymentMetadata = Object.entries(params.payment_intent_data?.metadata ?? {});
  const paymentCustomerId = paymentIntent && (typeof paymentIntent.customer === "string"
    ? paymentIntent.customer
    : paymentIntent.customer?.id);
  const paymentIdentityMatches = paymentIntent === null
    ? checkoutSession.status !== "complete"
    : paymentCustomerId === params.customer &&
      paymentIntent.amount === expectedPriceData?.unit_amount &&
      paymentIntent.currency?.toLowerCase() === expectedPriceData?.currency?.toLowerCase();
  const expectedSetupFutureUsage = params.payment_intent_data?.setup_future_usage;
  const setupFutureUsageMatches = expectedSetupFutureUsage === undefined ||
    (paymentIntent !== null && paymentIntent.setup_future_usage === expectedSetupFutureUsage) ||
    (paymentIntent === null && checkoutSession.status !== "complete");
  const expectedInvoiceCreation = params.invoice_creation?.enabled;
  const invoiceCreationMatches = expectedInvoiceCreation === undefined || checkoutSession.invoice_creation?.enabled === expectedInvoiceCreation;
  const paymentMetadataMatches = expectedPaymentMetadata.length === 0 ||
    (paymentIntent !== null && expectedPaymentMetadata.every(
      ([key, value]) => paymentIntent.metadata?.[key] === value,
    )) ||
    (paymentIntent === null && checkoutSession.status !== "complete");
  const customerId = typeof checkoutSession.customer === "string"
    ? checkoutSession.customer
    : checkoutSession.customer?.id;
  return checkoutSession.mode === params.mode &&
    customerId === params.customer &&
    checkoutSession.success_url === params.success_url &&
    checkoutSession.cancel_url === params.cancel_url &&
    metadataMatches &&
    checkoutSession.amount_total === expectedPriceData?.unit_amount &&
    checkoutSession.currency?.toLowerCase() === expectedPriceData?.currency?.toLowerCase() &&
    actualLine?.length === 1 &&
    actualLine[0].quantity === expectedLine?.quantity &&
    productMatches &&
    paymentIdentityMatches &&
    setupFutureUsageMatches &&
    invoiceCreationMatches &&
    paymentMetadataMatches;
}

import Stripe from "stripe";

export type PackageCheckoutDiscoveryExpectation = {
  customerId: string;
  userId: string;
  packageId: string;
  discoveryToken: string;
  createdAt?: Date;
};

export type PackageCheckoutDiscovery =
  | { status: "none" }
  | { status: "single"; session: Stripe.Checkout.Session }
  | { status: "multiple"; sessions: Stripe.Checkout.Session[] };

export async function discoverLegacyPackageCheckoutAttempt({ stripe, params, customerId, userId, packageId, createdAt }: { stripe: Pick<Stripe, "checkout" | "paymentIntents">; params: Stripe.Checkout.SessionCreateParams; customerId: string; userId: string; packageId: string; createdAt?: Date }): Promise<PackageCheckoutDiscovery> {
  const matches = new Map<string, Stripe.Checkout.Session>();
  for (const status of ["open", "complete", "expired"] as const) {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.checkout.sessions.list({ customer: customerId, status, limit: 100, ...(createdAt ? { created: { gte: Math.max(0, Math.floor(createdAt.getTime() / 1000) - 300) } } : {}), ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const session of page.data) {
        const sessionCustomer = customerIdOf(session);
        if (sessionCustomer === customerId && session.mode === "payment" && session.metadata?.beutlApplication === "beutl-web" && session.metadata?.beutlUserId === userId && session.metadata?.beutlPurchaseKind === "package" && session.metadata?.packageId === packageId && !session.metadata?.packageCheckoutAttemptId && await legacySessionMatchesObservableParams(stripe, session, params, customerId)) matches.set(session.id, session);
      }
      if (!page.has_more) break;
      const last = page.data.at(-1);
      if (!last) throw new Error(`Stripe returned an empty ${status} Checkout page with has_more`);
      startingAfter = last.id;
    }
  }
  const sessions = [...matches.values()];
  return sessions.length === 0 ? { status: "none" } : sessions.length === 1 ? { status: "single", session: sessions[0] } : { status: "multiple", sessions };
}

async function legacySessionMatchesObservableParams(stripe: Pick<Stripe, "checkout" | "paymentIntents">, listed: Stripe.Checkout.Session, params: Stripe.Checkout.SessionCreateParams, customerId: string): Promise<boolean> {
  const session = await stripe.checkout.sessions.retrieve(listed.id, { expand: ["line_items.data.price.product", "payment_intent"] });
  if ((typeof session.customer === "string" ? session.customer : session.customer?.id) !== customerId || session.mode !== params.mode || session.success_url !== params.success_url || session.cancel_url !== params.cancel_url) return false;
  const line = session.line_items?.data?.[0];
  const expectedLine = params.line_items?.[0];
  if (!line || !expectedLine || line.quantity !== expectedLine.quantity || !(("price_data" in expectedLine) && expectedLine.price_data)) return false;
  const priceData = expectedLine.price_data;
  if (session.amount_total !== priceData.unit_amount || session.currency?.toLowerCase() !== priceData.currency.toLowerCase()) return false;
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const expectedPiMetadata = params.payment_intent_data?.metadata ?? {};
  if (Object.keys(expectedPiMetadata).length > 0) {
    if (!paymentIntentId) return false;
    const paymentIntent = typeof session.payment_intent === "object" && session.payment_intent ? session.payment_intent : await stripe.paymentIntents.retrieve(paymentIntentId);
    if (!Object.entries(expectedPiMetadata).every(([key, value]) => paymentIntent.metadata?.[key] === value)) return false;
  }
  const expectedProduct = priceData.product_data;
  const actualProduct = typeof line.price === "object" && line.price?.product && typeof line.price.product === "object" && !("deleted" in line.price.product) ? line.price.product : null;
  if (!expectedProduct || !actualProduct) return false;
  return actualProduct.name === expectedProduct.name && (expectedProduct.description === undefined || actualProduct.description === expectedProduct.description) && JSON.stringify(actualProduct.images ?? []) === JSON.stringify(expectedProduct.images ?? []);
}

export async function discoverTopUpCheckoutAttempt({ stripe, customerId, userId, attemptId, billingOfferId, createdAt }: { stripe: Pick<Stripe, "checkout">; customerId: string; userId: string; attemptId: string; billingOfferId: string; createdAt?: Date }): Promise<PackageCheckoutDiscovery> {
  const matches = new Map<string, Stripe.Checkout.Session>();
  for (const status of ["open", "complete", "expired"] as const) {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.checkout.sessions.list({ customer: customerId, status, limit: 100, ...(createdAt ? { created: { gte: Math.max(0, Math.floor(createdAt.getTime() / 1000) - 300) } } : {}), ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const session of page.data) {
        const sessionCustomer = customerIdOf(session);
        if (sessionCustomer === customerId && session.metadata?.beutlApplication === "beutl-web" && session.metadata?.beutlUserId === userId && session.metadata?.topUpAttemptId === attemptId && session.metadata?.billingOfferId === billingOfferId) matches.set(session.id, session);
      }
      if (!page.has_more) break;
      const last = page.data.at(-1);
      if (!last) throw new Error(`Stripe returned an empty ${status} Checkout page with has_more`);
      startingAfter = last.id;
    }
  }
  const sessions = [...matches.values()];
  return sessions.length === 0 ? { status: "none" } : sessions.length === 1 ? { status: "single", session: sessions[0] } : { status: "multiple", sessions };
}

function customerIdOf(session: Stripe.Checkout.Session): string | null {
  return typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
}

export async function discoverPackageCheckoutAttempt({
  stripe,
  expected,
  pageSize = 100,
}: {
  stripe: Pick<Stripe, "checkout">;
  expected: PackageCheckoutDiscoveryExpectation;
  pageSize?: number;
}): Promise<PackageCheckoutDiscovery> {
  const matches = new Map<string, Stripe.Checkout.Session>();
  for (const status of ["open", "complete", "expired"] as const) {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.checkout.sessions.list({
        customer: expected.customerId,
        status,
        limit: pageSize,
        ...(expected.createdAt ? { created: { gte: Math.max(0, Math.floor(expected.createdAt.getTime() / 1000) - 300) } } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const session of page.data) {
        if (
          customerIdOf(session) === expected.customerId &&
          session.mode === "payment" &&
          session.metadata?.beutlApplication === "beutl-web" &&
          session.metadata?.beutlUserId === expected.userId &&
          session.metadata?.beutlPurchaseKind === "package" &&
          session.metadata?.packageId === expected.packageId &&
          session.metadata?.packageCheckoutAttemptId === expected.discoveryToken
        ) {
          matches.set(session.id, session);
        }
      }
      if (!page.has_more) break;
      const last = page.data.at(-1);
      if (!last) throw new Error(`Stripe returned an empty ${status} Checkout page with has_more`);
      startingAfter = last.id;
    }
  }
  const sessions = [...matches.values()];
  return sessions.length === 0
    ? { status: "none" }
    : sessions.length === 1
      ? { status: "single", session: sessions[0] }
      : { status: "multiple", sessions };
}

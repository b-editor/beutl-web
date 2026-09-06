import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveOwnedCustomerId } from "@/lib/customer";
import {
  bindPackageCheckoutSession,
  bindDiscoveredPackageCheckoutSession,
  findPackagePaymentReference,
  getOrCreatePackageCheckoutAttempt,
  markPackageCheckoutAttemptIntervention,
  markPackageCheckoutAttemptTerminal,
  terminalizePackageCheckoutUnderCreateLease,
  claimPackageCheckoutCreateLease,
  releasePackageCheckoutCreateLease,
  resolvePackageCheckoutAttemptIntervention,
} from "@beutl/db";
import { createStripe } from "@/lib/stripe/config";
import {
  packageCheckoutFingerprintInput,
  shouldReuseBoundPackageCheckoutSession,
  classifyPackageCheckoutCompletion,
  listAllOpenPackageCheckoutSessions,
  listLegacyCompletePackageCheckoutSessions,
  isOwnedPackageCheckoutCandidate,
  packagePaymentIntentMetadata,
  matchesPersistedPackageCheckoutSession,
  PACKAGE_CHECKOUT_SESSION_EXACT_EXPANDS,
  type PackagePurchaseExpectation,
} from "@/lib/stripe/store-checkout";
import { notFound, redirect } from "next/navigation";
import { guessCurrency } from "@/lib/currency";
import { createHash, selectPricing } from "@beutl/core";
import {
  packageOwned,
  retrievePackage,
  retrievePrices,
} from "@/lib/store-utils";
import { discoverPackageCheckoutAttempt } from "@beutl/api";
import { PACKAGE_CHECKOUT_CREATE_TIMEOUT_MS } from "@beutl/api";
import type Stripe from "stripe";

// Stripe が 1 ページで返す上限。1 顧客の未払いセッションがこれを超えることは
// 現実には無く、超えた分は使い回せず新しいセッションになるだけ。
const OPEN_SESSION_PAGE_LIMIT = 100;

async function loadExactDiscoveredPackageSession(
  stripe: ReturnType<typeof createStripe>,
  session: Stripe.Checkout.Session,
  params: Stripe.Checkout.SessionCreateParams,
): Promise<Stripe.Checkout.Session> {
  const remote = await stripe.checkout.sessions.retrieve(session.id, { expand: [...PACKAGE_CHECKOUT_SESSION_EXACT_EXPANDS] });
  const paymentIntent = typeof remote.payment_intent === "object" && remote.payment_intent
    ? remote.payment_intent
    : typeof remote.payment_intent === "string"
      ? await stripe.paymentIntents.retrieve(remote.payment_intent)
      : null;
  const exact = matchesPersistedPackageCheckoutSession(remote, params, paymentIntent);
  if (!exact) throw new Error(`Checkout Session ${session.id} failed exact persisted-params validation`);
  return remote;
}

function publicOrigin(): string {
  return process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net";
}

export default async function Page(props: {
  params: Promise<{ name: string; lang: string }>;
}) {
  const { name, lang } = await props.params;

  const session = await authOrSignIn();
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  if (await packageOwned(pkg.id, session.user.id)) {
    redirect(`/store/${name}`);
  }
  const currencyP = guessCurrency();
  const prices = await retrievePrices(pkg.id);
  const currency = await currencyP;
  const price = selectPricing(prices, currency);
  if (!price) {
    throw new Error("No price found");
  }

  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  const stripe = createStripe();
  const expectation: PackagePurchaseExpectation = {
    customerId,
    userId: session.user.id,
    packageId: pkg.id,
    amount: price.price,
    currency: price.currency,
  };

  const origin = publicOrigin();
  const metadata = packagePaymentIntentMetadata(session.user.id, pkg.id);
  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: price.currency,
          unit_amount: price.price,
          product_data: {
            name: pkg.displayName || pkg.name,
            ...(pkg.shortDescription
              ? { description: pkg.shortDescription }
              : {}),
            ...(pkg.iconFileUrl
              ? { images: [`${origin}${pkg.iconFileUrl}`] }
              : {}),
          },
        },
      },
    ],
    // webhook はこのメタデータだけを見てパッケージの引き渡しを判断するので、
    // Checkout Session ではなく PaymentIntent 側に必ず載せる。
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata,
    },
    // 支払いごとに Stripe の請求書を残す。請求ページの支払い履歴はここから
    // 請求書のリンクを引く。
    invoice_creation: { enabled: true },
    metadata,
    success_url: `${origin}/${lang}/store/${name}/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/${lang}/store/${name}`,
  };

  // A retry is safe only when every Stripe parameter is identical. Keep the
  // attempt key stable for network retries, but derive it from the complete
  // logical attempt so a changed price, currency, customer, or locale cannot
  // replay the old PaymentIntent.
  const attemptFingerprint = (
    await createHash(JSON.stringify(packageCheckoutFingerprintInput(checkoutParams)))
  ).slice(0, 32);
  let attempt = await getOrCreatePackageCheckoutAttempt({
    userId: session.user.id,
    packageId: pkg.id,
    fingerprint: attemptFingerprint,
    customerId,
    paramsJson: JSON.stringify(checkoutParams),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  while (attempt.stripeCheckoutSessionId) {
    const persistedAttemptParams = JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams;
    // The Session id is the durable identity for pre-token attempts. Retrieve
    // and validate its complete persisted observable parameters before reuse,
    // terminalization, or generation rotation; a similar unbound Session is
    // never attached to this attempt.
    const existing = await loadExactDiscoveredPackageSession(
      stripe,
      { id: attempt.stripeCheckoutSessionId } as Stripe.Checkout.Session,
      persistedAttemptParams,
    );
    const matchesCurrentAttempt = shouldReuseBoundPackageCheckoutSession({
      attemptFingerprint: attempt.fingerprint,
      currentFingerprint: attemptFingerprint,
      checkoutSession: existing,
      expected: expectation,
      lang,
      packageName: name,
    });
    if (existing.status === "open" && existing.url && matchesCurrentAttempt) {
      redirect(existing.url);
    }
    if (existing.status === "open" && !isOwnedPackageCheckoutCandidate(existing, expectation)) {
      throw new Error(`Bound Checkout Session ${existing.id} failed ownership validation`);
    }
    if (existing.status === "open") {
      try {
        await stripe.checkout.sessions.expire(existing.id);
      } catch (error) {
        const resolved = await stripe.checkout.sessions.retrieve(existing.id, { expand: ["payment_intent"] });
        if (resolved.status === "complete") {
          const resolvedPaymentIntentId = typeof resolved.payment_intent === "string" ? resolved.payment_intent : resolved.payment_intent?.id;
          if (!resolvedPaymentIntentId) throw new Error(`Completed Checkout Session ${resolved.id} has no PaymentIntent`);
          const resolvedIntent = await stripe.paymentIntents.retrieve(resolvedPaymentIntentId);
          const resolvedRecord = await findPackagePaymentReference({ paymentId: resolvedIntent.id });
          if (classifyPackageCheckoutCompletion({ checkoutSession: resolved, paymentIntent: resolvedIntent, paymentRecord: resolvedRecord }) === "complete-pending") {
            redirect(`/${lang}/store/${name}/checkout/complete?session_id=${resolved.id}`);
          }
        } else if (resolved.status !== "expired") {
          throw error;
        }
      }
    }
    if (existing.status === "complete") {
      const paymentIntentId = typeof existing.payment_intent === "string" ? existing.payment_intent : existing.payment_intent?.id;
      const paymentIntent = paymentIntentId ? await stripe.paymentIntents.retrieve(paymentIntentId) : null;
      const paymentRecord = paymentIntent
        ? await findPackagePaymentReference({ paymentId: paymentIntent.id })
        : null;
      const decision = classifyPackageCheckoutCompletion({
        checkoutSession: existing,
        paymentIntent,
        paymentRecord,
      });
      if (decision === "complete-pending") {
        redirect(`/${lang}/store/${name}/checkout/complete?session_id=${existing.id}`);
      }
    }
    const terminalized = await markPackageCheckoutAttemptTerminal({
      id: attempt.id,
      checkoutKey: attempt.checkoutKey,
      stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
    });
    if (terminalized.count !== 1) {
      attempt = await getOrCreatePackageCheckoutAttempt({
        userId: session.user.id,
        packageId: pkg.id,
        fingerprint: attemptFingerprint,
        customerId,
        paramsJson: JSON.stringify(checkoutParams),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      continue;
    }
    attempt = await getOrCreatePackageCheckoutAttempt({
      userId: session.user.id,
      packageId: pkg.id,
      fingerprint: attemptFingerprint,
      customerId,
      paramsJson: JSON.stringify(checkoutParams),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  // A pre-token attempt without a bound Session has no durable remote handle.
  // Similar customer/price metadata is intentionally insufficient to bind
  // one of the user's open legacy Sessions, so leave the row in intervention
  // for exhaustive/operator resolution instead of silently creating a new
  // generation around an ambiguous outcome.
  const unboundPersistedParams = JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams;
  if (!attempt.stripeCheckoutSessionId && unboundPersistedParams.metadata?.packageCheckoutAttemptId !== attempt.discoveryToken) {
    await markPackageCheckoutAttemptIntervention({
      id: attempt.id,
      checkoutKey: attempt.checkoutKey,
      lastError: "Legacy unbound package Checkout attempt requires remote resolution before tokenized retry",
    });
    throw new Error("Legacy unbound package Checkout attempt requires remote resolution before tokenized retry");
  }

  // Only after the DB attempt has been selected may a legacy open Session be
  // reused or expired. This prevents a stale Session from bypassing the
  // single active-attempt state machine.
  if (attempt.status === "intervention") {
    const interventionDiscovery = await discoverPackageCheckoutAttempt({ stripe, expected: { customerId, userId: session.user.id, packageId: pkg.id, discoveryToken: attempt.discoveryToken, createdAt: attempt.createdAt } });
    if (interventionDiscovery.status === "multiple") throw new Error("Multiple Checkout Sessions matched intervention attempt");
    if (interventionDiscovery.status === "none") throw new Error("Package Checkout recovery requires operator intervention after exhaustive remote discovery");
    const interventionSession = interventionDiscovery.session;
    if (interventionSession.status === "open") {
      const bound = await bindDiscoveredPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, stripeCheckoutSessionId: interventionSession.id, expiresAt: interventionSession.expires_at ? new Date(interventionSession.expires_at * 1000) : attempt.expiresAt });
      if (bound.count !== 1 || !interventionSession.url) throw new Error("Intervention Session binding was superseded");
      redirect(interventionSession.url);
    }
    if (interventionSession.status === "complete") {
      const piId = typeof interventionSession.payment_intent === "string" ? interventionSession.payment_intent : interventionSession.payment_intent?.id;
      const pi = piId ? await stripe.paymentIntents.retrieve(piId) : null;
      const rec = pi ? await findPackagePaymentReference({ paymentId: pi.id }) : null;
      if (classifyPackageCheckoutCompletion({ checkoutSession: interventionSession, paymentIntent: pi, paymentRecord: rec }) === "complete-pending") {
        const bound = await bindDiscoveredPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, stripeCheckoutSessionId: interventionSession.id, expiresAt: interventionSession.expires_at ? new Date(interventionSession.expires_at * 1000) : attempt.expiresAt });
        if (bound.count !== 1) throw new Error("Intervention completed Session binding was superseded");
        redirect(`/${lang}/store/${name}/checkout/complete?session_id=${interventionSession.id}`);
      }
      if (!piId || !pi) throw new Error("Terminal completed intervention lacks PaymentIntent evidence");
      await resolvePackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, remoteResolution: { status: "terminal-complete", sessionId: interventionSession.id, paymentIntentId: pi.id, paymentStatus: pi.status } });
    }
    if (interventionSession.status === "expired") await resolvePackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, remoteResolution: { status: "expired", sessionId: interventionSession.id } });
    attempt = await getOrCreatePackageCheckoutAttempt({ userId: session.user.id, packageId: pkg.id, fingerprint: attemptFingerprint, customerId, paramsJson: JSON.stringify(checkoutParams), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  }
  let createLeaseToken = crypto.randomUUID();
  if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
  const discovery = await discoverPackageCheckoutAttempt({
    stripe,
    expected: { customerId, userId: session.user.id, packageId: pkg.id, discoveryToken: attempt.discoveryToken, createdAt: attempt.createdAt },
  });
  if (discovery.status === "multiple") {
    await markPackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, createLeaseToken, lastError: `Multiple Checkout Sessions matched discovery token ${attempt.discoveryToken}` });
    throw new Error(`Multiple Stripe Checkout Sessions were associated with package attempt ${attempt.id}`);
  }
  const discoveredSession = discovery.status === "single" ? discovery.session : undefined;
  if (!discoveredSession && attempt.status === "intervention") {
    throw new Error("Package Checkout recovery requires operator intervention after exhaustive remote discovery");
  }
  if (!discoveredSession && attempt.fingerprint !== attemptFingerprint) {
    if ((await terminalizePackageCheckoutUnderCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, createLeaseToken, stripeCheckoutSessionId: null })).count !== 1) throw new Error("Package Checkout attempt changed during fingerprint rotation");
    attempt = await getOrCreatePackageCheckoutAttempt({ userId: session.user.id, packageId: pkg.id, fingerprint: attemptFingerprint, customerId, paramsJson: JSON.stringify(checkoutParams), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    createLeaseToken = crypto.randomUUID();
    if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
  }
  const openSessions = await listAllOpenPackageCheckoutSessions({ stripe, customerId, pageSize: OPEN_SESSION_PAGE_LIMIT });
  const legacyCompleteSessions = await listLegacyCompletePackageCheckoutSessions({ stripe, customerId, userId: session.user.id, packageId: pkg.id, pageSize: OPEN_SESSION_PAGE_LIMIT });
  for (const legacyComplete of legacyCompleteSessions) {
    if (!legacyComplete.metadata?.packageCheckoutAttemptId) {
      const paymentIntentId = typeof legacyComplete.payment_intent === "string" ? legacyComplete.payment_intent : legacyComplete.payment_intent?.id;
      if (!paymentIntentId) { await releasePackageCheckoutCreateLease({ id: attempt.id, leaseToken: createLeaseToken }); redirect(`/${lang}/store/${name}/checkout/complete?session_id=${legacyComplete.id}`); }
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const paymentRecord = await findPackagePaymentReference({ paymentId: paymentIntent.id });
      if (classifyPackageCheckoutCompletion({ checkoutSession: legacyComplete, paymentIntent, paymentRecord }) === "complete-pending") { await releasePackageCheckoutCreateLease({ id: attempt.id, leaseToken: createLeaseToken }); redirect(`/${lang}/store/${name}/checkout/complete?session_id=${legacyComplete.id}`); }
    }
  }
  if (discoveredSession) {
    if (!isOwnedPackageCheckoutCandidate(discoveredSession, expectation)) {
      throw new Error(`Checkout Session ${discoveredSession.id} failed durable attempt ownership validation`);
    }
    const persistedAttemptParams = JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams;
    const discoveredRemote = discoveredSession.status === "expired"
      ? await stripe.checkout.sessions.retrieve(discoveredSession.id)
      : await loadExactDiscoveredPackageSession(stripe, discoveredSession, persistedAttemptParams);
    const discoveredFingerprint = await createHash(JSON.stringify(packageCheckoutFingerprintInput({
      ...persistedAttemptParams,
      metadata: Object.fromEntries(Object.entries(persistedAttemptParams.metadata ?? {}).filter(([key]) => key !== "packageCheckoutAttemptId")),
      payment_intent_data: persistedAttemptParams.payment_intent_data && typeof persistedAttemptParams.payment_intent_data === "object"
        ? { ...persistedAttemptParams.payment_intent_data, metadata: Object.fromEntries(Object.entries(persistedAttemptParams.payment_intent_data.metadata ?? {}).filter(([key]) => key !== "packageCheckoutAttemptId")) }
        : persistedAttemptParams.payment_intent_data,
    }))).then((hash) => hash.slice(0, 32));
    if (discoveredFingerprint !== attemptFingerprint) {
      if (discoveredRemote.status === "complete") {
        const bound = await bindPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, createLeaseToken, stripeCheckoutSessionId: discoveredRemote.id, expiresAt: discoveredRemote.expires_at ? new Date(discoveredRemote.expires_at * 1000) : attempt.expiresAt });
        if (bound !== "bound" && bound !== "already-bound") throw new Error("Discovered completed Session binding was superseded");
        redirect(`/${lang}/store/${name}/checkout/complete?session_id=${discoveredRemote.id}`);
      }
      if (discoveredRemote.status === "open") {
        try {
          await stripe.checkout.sessions.expire(discoveredRemote.id);
        } catch (error) {
          const resolved = await stripe.checkout.sessions.retrieve(discoveredRemote.id);
          if (resolved.status === "complete") redirect(`/${lang}/store/${name}/checkout/complete?session_id=${resolved.id}`);
          if (resolved.status !== "expired") throw error;
        }
      }
      const terminalized = attempt.status === "intervention"
        ? await resolvePackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, remoteResolution: { sessionId: discoveredRemote.id, status: "expired" } })
        : await terminalizePackageCheckoutUnderCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, createLeaseToken, stripeCheckoutSessionId: null });
      if (terminalized.count !== 1) throw new Error("Package Checkout attempt changed during changed-fingerprint recovery");
      attempt = await getOrCreatePackageCheckoutAttempt({ userId: session.user.id, packageId: pkg.id, fingerprint: attemptFingerprint, customerId, paramsJson: JSON.stringify(checkoutParams), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
      createLeaseToken = crypto.randomUUID();
      if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
    } else if (discoveredRemote.status === "complete") {
      const discoveredPaymentIntentId = typeof discoveredRemote.payment_intent === "string" ? discoveredRemote.payment_intent : discoveredRemote.payment_intent?.id;
      const discoveredPaymentIntent = discoveredPaymentIntentId ? await stripe.paymentIntents.retrieve(discoveredPaymentIntentId) : null;
      const discoveredPaymentRecord = discoveredPaymentIntent ? await findPackagePaymentReference({ paymentId: discoveredPaymentIntent.id }) : null;
      const discoveredDecision = classifyPackageCheckoutCompletion({ checkoutSession: discoveredRemote, paymentIntent: discoveredPaymentIntent, paymentRecord: discoveredPaymentRecord });
      if (discoveredDecision === "complete-pending") { const bound = await bindPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, createLeaseToken, stripeCheckoutSessionId: discoveredRemote.id, expiresAt: discoveredRemote.expires_at ? new Date(discoveredRemote.expires_at * 1000) : attempt.expiresAt }); if (bound !== "bound" && bound !== "already-bound") throw new Error("Discovered completed Session binding was superseded"); redirect(`/${lang}/store/${name}/checkout/complete?session_id=${discoveredRemote.id}`); }
      const terminalized = attempt.status === "intervention"
        ? await resolvePackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, remoteResolution: { status: "expired", sessionId: discoveredRemote.id } })
        : await terminalizePackageCheckoutUnderCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, createLeaseToken, stripeCheckoutSessionId: null });
      if (terminalized.count !== 1) throw new Error("Package Checkout attempt changed during terminal completion recovery");
      attempt = await getOrCreatePackageCheckoutAttempt({ userId: session.user.id, packageId: pkg.id, fingerprint: attemptFingerprint, customerId, paramsJson: JSON.stringify(checkoutParams), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
      createLeaseToken = crypto.randomUUID();
      if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
    } else if (discoveredRemote.status === "expired") {
      const terminalized = attempt.status === "intervention"
        ? await resolvePackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, remoteResolution: { sessionId: discoveredRemote.id, status: "expired" } })
        : await terminalizePackageCheckoutUnderCreateLease({
        id: attempt.id,
        checkoutKey: attempt.checkoutKey,
        discoveryToken: attempt.discoveryToken,
        createLeaseToken,
        stripeCheckoutSessionId: null,
      });
      if (terminalized.count !== 1) throw new Error("Package Checkout attempt changed during expired-session recovery");
      attempt = await getOrCreatePackageCheckoutAttempt({
        userId: session.user.id,
        packageId: pkg.id,
        fingerprint: attemptFingerprint,
        customerId,
        paramsJson: JSON.stringify(checkoutParams),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      createLeaseToken = crypto.randomUUID();
      if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
    } else if (discoveredRemote.status === "open") {
      const bindingResult = attempt.status === "intervention"
        ? await bindDiscoveredPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, stripeCheckoutSessionId: discoveredRemote.id, expiresAt: discoveredRemote.expires_at ? new Date(discoveredRemote.expires_at * 1000) : attempt.expiresAt })
        : await bindPackageCheckoutSession({
        id: attempt.id,
        checkoutKey: attempt.checkoutKey,
        createLeaseToken,
        stripeCheckoutSessionId: discoveredRemote.id,
        expiresAt: discoveredRemote.expires_at ? new Date(discoveredRemote.expires_at * 1000) : attempt.expiresAt,
      });
      if ((typeof bindingResult === "object" && bindingResult.count === 1) || bindingResult === "bound" || bindingResult === "already-bound") {
        if (!discoveredRemote.url) throw new Error(`Checkout Session ${discoveredRemote.id} was created without a URL`);
        redirect(discoveredRemote.url);
      }
      throw new Error(`Checkout Session ${discoveredSession.id} discovery binding was superseded`);
    }
  }
  // An unbound legacy Session has no durable association with this attempt.
  // Amount/metadata/success_url similarities are insufficient to bind it: it
  // may belong to a prior parameter set or a response-lost create. Resolve it
  // (and redirect a completed payment) without ever attaching it locally.
  for (const candidate of openSessions) {
    if (
      isOwnedPackageCheckoutCandidate(candidate, expectation) &&
      candidate.status === "open"
    ) {
      try {
        const resolved = await stripe.checkout.sessions.expire(candidate.id);
        if (resolved.status === "complete") redirect(`/${lang}/store/${name}/checkout/complete?session_id=${resolved.id}`);
      } catch (error) {
        const final = await stripe.checkout.sessions.retrieve(candidate.id);
        if (final.status === "complete") redirect(`/${lang}/store/${name}/checkout/complete?session_id=${final.id}`);
        if (final.status !== "expired") throw error;
      }
    }
  }

  const retentionBoundary = 24 * 60 * 60 * 1000;
  if (Date.now() - attempt.createdAt.getTime() >= retentionBoundary) {
    await markPackageCheckoutAttemptIntervention({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, createLeaseToken, lastError: "Stripe idempotency retention elapsed after exhaustive Checkout discovery" });
    throw new Error("Package Checkout recovery requires operator intervention after Stripe idempotency retention");
  }

  async function resolveRejectedSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    let current = await stripe.checkout.sessions.retrieve(sessionId);
    if (current.status === "open") {
      try {
        current = await stripe.checkout.sessions.expire(sessionId);
      } catch (error) {
        current = await stripe.checkout.sessions.retrieve(sessionId);
        if (current.status !== "complete" && current.status !== "expired") {
          throw error;
        }
      }
    }
    return current;
  }

  // A terminal response can be a replay of an unbound network-lost create.
  // CAS-terminalize the DB attempt, rotate its UUID, and retry without a
  // finite replacement-key list that could strand the purchase.
  for (;;) {
    const persistedCheckoutParams = JSON.parse(attempt.paramsJson) as Stripe.Checkout.SessionCreateParams;
    const candidate = await stripe.checkout.sessions.create(persistedCheckoutParams, {
      idempotencyKey: attempt.checkoutKey,
      timeout: PACKAGE_CHECKOUT_CREATE_TIMEOUT_MS,
      maxNetworkRetries: 2,
    });
    if (candidate.status !== "open") {
      if (candidate.status === "complete") {
        const paymentIntentId =
          typeof candidate.payment_intent === "string"
            ? candidate.payment_intent
            : candidate.payment_intent?.id;
        if (!paymentIntentId) {
          throw new Error(`Completed Checkout Session ${candidate.id} has no PaymentIntent`);
        }
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        const paymentRecord = await findPackagePaymentReference({ paymentId: paymentIntent.id });
        const decision = classifyPackageCheckoutCompletion({
          checkoutSession: candidate,
          paymentIntent,
          paymentRecord,
        });
        if (decision === "complete-pending") { const bound = await bindPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, createLeaseToken, stripeCheckoutSessionId: candidate.id, expiresAt: candidate.expires_at ? new Date(candidate.expires_at * 1000) : attempt.expiresAt }); if (bound !== "bound" && bound !== "already-bound") throw new Error("Completed Checkout Session binding was superseded"); redirect(`/${lang}/store/${name}/checkout/complete?session_id=${candidate.id}`); }
      }
      const terminalized = await terminalizePackageCheckoutUnderCreateLease({
        id: attempt.id,
        checkoutKey: attempt.checkoutKey,
        discoveryToken: attempt.discoveryToken,
        createLeaseToken,
        stripeCheckoutSessionId: null,
      });
      if (terminalized.count !== 1) {
        attempt = await getOrCreatePackageCheckoutAttempt({
          userId: session.user.id,
          packageId: pkg.id,
          fingerprint: attemptFingerprint,
          customerId,
          paramsJson: JSON.stringify(checkoutParams),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        createLeaseToken = crypto.randomUUID();
        if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
        continue;
      }
      attempt = await getOrCreatePackageCheckoutAttempt({
        userId: session.user.id,
        packageId: pkg.id,
        fingerprint: attemptFingerprint,
        customerId,
        paramsJson: JSON.stringify(checkoutParams),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      createLeaseToken = crypto.randomUUID();
      if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
      continue;
    }
    const binding = await bindPackageCheckoutSession({
      id: attempt.id,
      checkoutKey: attempt.checkoutKey,
      createLeaseToken,
      stripeCheckoutSessionId: candidate.id,
      expiresAt: candidate.expires_at
        ? new Date(candidate.expires_at * 1000)
        : attempt.expiresAt,
    });
    if (binding === "bound" || binding === "already-bound") {
      if (!candidate.url) throw new Error(`Checkout Session ${candidate.id} was created without a URL`);
      redirect(candidate.url);
    }
    const resolved = await resolveRejectedSession(candidate.id);
    if (resolved.status === "complete") {
      const resolvedPaymentIntentId =
        typeof resolved.payment_intent === "string"
          ? resolved.payment_intent
          : resolved.payment_intent?.id;
      if (!resolvedPaymentIntentId) {
        throw new Error(`Completed Checkout Session ${resolved.id} has no PaymentIntent`);
      }
      const paymentIntent = await stripe.paymentIntents.retrieve(
        resolvedPaymentIntentId,
      );
      const paymentRecord = await findPackagePaymentReference({
        paymentId: paymentIntent.id,
      });
      const decision = classifyPackageCheckoutCompletion({
        checkoutSession: resolved,
        paymentIntent,
        paymentRecord,
      });
      if (decision === "complete-pending") {
        const bound = await bindPackageCheckoutSession({ id: attempt.id, checkoutKey: attempt.checkoutKey, createLeaseToken, stripeCheckoutSessionId: resolved.id, expiresAt: resolved.expires_at ? new Date(resolved.expires_at * 1000) : attempt.expiresAt }); if (bound !== "bound" && bound !== "already-bound") throw new Error("Completed Checkout Session binding was superseded"); redirect(`/${lang}/store/${name}/checkout/complete?session_id=${resolved.id}`);
      }
      const terminalized = await terminalizePackageCheckoutUnderCreateLease({
        id: attempt.id,
        checkoutKey: attempt.checkoutKey,
        discoveryToken: attempt.discoveryToken,
        createLeaseToken,
        stripeCheckoutSessionId: null,
      });
      if (terminalized.count !== 1) {
        attempt = await getOrCreatePackageCheckoutAttempt({
          userId: session.user.id,
          packageId: pkg.id,
          fingerprint: attemptFingerprint,
          customerId,
          paramsJson: JSON.stringify(checkoutParams),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        createLeaseToken = crypto.randomUUID();
        if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
        continue;
      }
      attempt = await getOrCreatePackageCheckoutAttempt({
        userId: session.user.id,
        packageId: pkg.id,
        fingerprint: attemptFingerprint,
        customerId,
        paramsJson: JSON.stringify(checkoutParams),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      createLeaseToken = crypto.randomUUID();
      if ((await claimPackageCheckoutCreateLease({ id: attempt.id, checkoutKey: attempt.checkoutKey, discoveryToken: attempt.discoveryToken, leaseToken: createLeaseToken })).count !== 1) throw new Error("Package Checkout creation is already in progress");
      continue;
    }
    if (binding === "account-deletion-authorized" || binding === "owned") {
      redirect(`/store/${name}`);
    }
    throw new Error(`Checkout Session ${candidate.id} binding was superseded`);
  }
}

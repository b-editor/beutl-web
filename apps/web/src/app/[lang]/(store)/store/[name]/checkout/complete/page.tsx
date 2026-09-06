import { authOrSignIn } from "@/lib/auth-guard";
import { createStripe } from "@/lib/stripe/config";
import {
  isOwnedPackageCheckoutSession,
  isOwnedPackagePaymentIntent,
  type PackagePurchaseExpectation,
} from "@/lib/stripe/store-checkout";
import { ClientPage } from "./components";
import { PackageDetails } from "./package-details";
import { notFound } from "next/navigation";
import { retrievePackage } from "@/lib/store-utils";
import { findCustomerByUserId, findPackagePaymentReference } from "@beutl/db";
import { resolvePackageCheckoutCompletionStatus } from "./status";
import type Stripe from "stripe";

type StripeClient = ReturnType<typeof createStripe>;

function singleParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Checkout から戻ってきたときは Session、この画面が PaymentElement だった頃に
// 出した戻り先からは PaymentIntent が渡ってくる。どちらも同じ支払いを指す。
async function retrieveOwnedPaymentIntent({
  stripe,
  checkoutSessionId,
  paymentIntentId,
  expectation,
}: {
  stripe: StripeClient;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  expectation: PackagePurchaseExpectation;
}): Promise<Stripe.PaymentIntent | null> {
  if (checkoutSessionId) {
    const checkoutSession = await stripe.checkout.sessions.retrieve(
      checkoutSessionId,
      { expand: ["payment_intent"] },
    );
    if (!isOwnedPackageCheckoutSession(checkoutSession, expectation)) {
      return null;
    }
    const paymentIntent = checkoutSession.payment_intent;
    return typeof paymentIntent === "string" || paymentIntent === null
      ? null
      : paymentIntent;
  }
  if (paymentIntentId) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return isOwnedPackagePaymentIntent(paymentIntent, expectation)
      ? paymentIntent
      : null;
  }
  return null;
}

export default async function Page(props: {
  params: Promise<{ name: string; lang: string }>;
  searchParams: Promise<{
    session_id?: string | string[];
    payment_intent?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const { name, lang } = await props.params;

  const session = await authOrSignIn();
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }

  const customer = await findCustomerByUserId({ userId: session.user.id });
  if (!customer) {
    notFound();
  }
  const stripe = createStripe();
  const intent = await retrieveOwnedPaymentIntent({
    stripe,
    checkoutSessionId: singleParam(searchParams.session_id),
    paymentIntentId: singleParam(searchParams.payment_intent),
    expectation: {
      customerId: customer.stripeId,
      userId: session.user.id,
      packageId: pkg.id,
    },
  });
  if (!intent) {
    notFound();
  }

  const payment = await findPackagePaymentReference({ paymentId: intent.id });
  const status = resolvePackageCheckoutCompletionStatus(intent.status, payment);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative flex max-md:flex-col gap-2">
        <div className="md:flex-1 mx-3 min-w-0">
          <PackageDetails
            pkg={pkg}
            price={intent.amount}
            currency={intent.currency}
            lang={lang}
          />
        </div>
        <div className="border max-md:h-[1px] md:w-[1px]" />
        <div className="md:flex-1 mx-2 max-md:mt-4">
          <ClientPage status={status} name={name} lang={lang} />
        </div>
      </div>
    </div>
  );
}

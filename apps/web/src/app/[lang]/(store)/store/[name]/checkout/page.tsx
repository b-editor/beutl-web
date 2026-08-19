import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveOwnedCustomerId } from "@/lib/customer";
import { createStripe } from "@/lib/stripe/config";
import {
  isOwnedPackageCheckoutSession,
  packagePaymentIntentMetadata,
  type PackagePurchaseExpectation,
} from "@/lib/stripe/store-checkout";
import { notFound, redirect } from "next/navigation";
import { guessCurrency } from "@/lib/currency";
import { selectPricing } from "@beutl/core";
import {
  packageOwned,
  retrievePackage,
  retrievePrices,
} from "@/lib/store-utils";

// Stripe が 1 ページで返す上限。1 顧客の未払いセッションがこれを超えることは
// 現実には無く、超えた分は使い回せず新しいセッションになるだけ。
const OPEN_SESSION_PAGE_LIMIT = 100;

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

  // 戻ってきたユーザーには前回の支払い口をそのまま渡す。作り直すと、同じ買い物に
  // 対して支払える口が並んで残る。
  const openSessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: "open",
    limit: OPEN_SESSION_PAGE_LIMIT,
  });
  const reusable = openSessions.data.find(
    (candidate) =>
      candidate.url !== null &&
      isOwnedPackageCheckoutSession(candidate, expectation),
  );
  if (reusable?.url) {
    redirect(reusable.url);
  }

  const origin = publicOrigin();
  const metadata = packagePaymentIntentMetadata(session.user.id, pkg.id);
  const checkoutSession = await stripe.checkout.sessions.create({
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
  });

  if (!checkoutSession.url) {
    throw new Error(
      `Checkout Session ${checkoutSession.id} was created without a URL`,
    );
  }
  redirect(checkoutSession.url);
}

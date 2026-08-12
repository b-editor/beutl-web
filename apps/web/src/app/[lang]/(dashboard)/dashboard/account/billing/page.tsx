import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { createStripe } from "@/lib/stripe/config";
import { Separator } from "@beutl/ui/ui/separator";
import { formatAmount } from "@beutl/core";
import { getCreditPurchasesByUserId, getUserPaymentHistory } from "@beutl/db";
import { findPackageForBillingHistory } from "@beutl/db";
import { Button } from "@beutl/ui/ui/button";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { packagePaymentReversalTranslationKey } from "@/lib/billing-history";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  const session = await authOrSignIn();

  const [history, creditPurchases] = await Promise.all([
    getUserPaymentHistory({ userId: session.user.id }),
    getCreditPurchasesByUserId({ userId: session.user.id }),
  ]);
  const { t } = await getTranslation(lang);
  const packageItems = await Promise.all(
    history.map(async (item) => {
      const p1 = findPackageForBillingHistory({
        packageId: item.packageId,
      });
      const stripe = createStripe();
      const p2 = stripe.paymentIntents.retrieve(item.paymentId);
      const [pkg, payment] = await Promise.all([p1, p2]);
      const reversalKey = packagePaymentReversalTranslationKey(item);
      return {
        product: pkg ? pkg.displayName || pkg.name : "不明なアイテム",
        seller:
          pkg?.user.Profile?.displayName || pkg?.user.name || "不明なユーザー",
        amount: payment.amount,
        currency: payment.currency,
        paiedAt: item.createdAt,
        id: item.id,
        credits: null as number | null,
        reversalNote: reversalKey ? t(reversalKey) : null,
      };
    }),
  );
  // Credit top-ups are money-in events and belong in the payment history. The
  // usage side of the credit ledger stays out of the UI so a user cannot infer
  // what each AI operation costs.
  const creditItems = creditPurchases
    .filter(
      (item) => item.stripePaymentAmount !== null && item.stripeCurrency !== null,
    )
    .map((item) => ({
      product: t("account:billing.creditPurchase"),
      seller: "",
      amount: item.stripePaymentAmount as number,
      currency: item.stripeCurrency as string,
      paiedAt: item.createdAt,
      id: item.id,
      // The purchased amount is a fixed quantity the user paid for, not a
      // per-operation cost, so it is safe to show.
      credits: item.creditAmount,
      // A refund or dispute can reverse a purchase after the fact, so the history
      // says so instead of implying the credits are still available.
      reversalNote: item.isFullyReversed
        ? t("account:billing.creditPurchaseRefunded")
        : item.reversedCredits > 0
          ? t("account:billing.creditPurchasePartiallyRefunded", {
              credits: item.reversedCredits.toLocaleString(
                lang === "ja" ? "ja-JP" : "en-US",
              ),
            })
          : null,
    }));
  const items = [...packageItems, ...creditItems].sort(
    (left, right) =>
      new Date(right.paiedAt).getTime() - new Date(left.paiedAt).getTime(),
  );

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("account:billing.title")}</h1>
      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:billing.paymentMethod")}
        </h3>
        <Separator />

        <div className="py-4 px-6">
          <Button asChild>
            <Link href="https://app.link.com/">
              <ExternalLink className="w-4 h-4 mr-2" />
              {t("account:billing.changePaymentMethod")}
            </Link>
          </Button>
        </div>
      </div>
      <div className="mt-4 rounded-lg border text-card-foreground">
        <div className="m-6 mb-4">
          <h3 className="font-bold text-md">
            {t("account:billing.paymentHistory")}
          </h3>
          <p className="mt-1 text-foreground/70 text-sm">
            {t("account:billing.paymentHistoryDescription")}
          </p>
        </div>
        <Separator />
        <ul className="[&_li:last-child]:border-0">
          {items.map((item) => (
            <li
              className="flex items-center py-4 px-6 gap-2 border-b"
              key={item.id}
            >
              <div className="flex-1">
                <p className="font-bold">{item.product}</p>
                <p className="text-foreground/70 text-sm">
                  {item.credits === null
                    ? item.seller
                    : t("account:billing.creditPurchaseAmount", {
                        credits: item.credits.toLocaleString(
                          lang === "ja" ? "ja-JP" : "en-US",
                        ),
                      })}
                </p>
                {item.reversalNote && (
                  <p className="text-amber-600 dark:text-amber-500 text-sm">
                    {item.reversalNote}
                  </p>
                )}
              </div>
              <div>{formatAmount(item.amount, item.currency, lang)}</div>
              <div>{new Date(item.paiedAt).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

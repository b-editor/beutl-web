import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { createStripe } from "@/lib/stripe/config";
import { Separator } from "@beutl/ui/ui/separator";
import { formatAmount } from "@beutl/core";
import { getUserPaymentHistory } from "@beutl/db";
import { findPackageForBillingHistory } from "@beutl/db";
import { Button } from "@beutl/ui/ui/button";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  const session = await authOrSignIn();

  const history = await getUserPaymentHistory({ userId: session.user.id });
  const items = await Promise.all(
    history.map(async (item) => {
      const p1 = findPackageForBillingHistory({
        packageId: item.packageId,
      });
      const stripe = createStripe();
      const p2 = stripe.paymentIntents.retrieve(item.paymentId);
      const [pkg, payment] = await Promise.all([p1, p2]);
      return {
        product: pkg ? pkg.displayName || pkg.name : "不明なアイテム",
        seller:
          pkg?.user.Profile?.displayName || pkg?.user.name || "不明なユーザー",
        amount: payment.amount,
        currency: payment.currency,
        paiedAt: item.createdAt,
        id: item.id,
      };
    }),
  );
  const { t } = await getTranslation(lang);

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
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:billing.paymentHistory")}
        </h3>
        <Separator />
        <ul className="[&_li:last-child]:border-0">
          {items.map((item) => (
            <li
              className="flex items-center py-4 px-6 gap-2 border-b"
              key={item.id}
            >
              <div className="flex-1">
                <p className="font-bold">{item.product}</p>
                <p className="text-foreground/70 text-sm">{item.seller}</p>
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

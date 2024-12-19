import { prisma } from "@/prisma";
import { getTranslation } from "@/app/i18n/server";
import { authOrSignIn } from "@/lib/auth-guard";
import { stripe } from "@/lib/stripe/config";
import { Separator } from "@/components/ui/separator";
import { formatAmount } from "@/lib/currency-formatter";
import { getUserPaymentHistory } from "@/lib/db/userPaymentHistory";

export default async function Page({ params: { lang } }: { params: { lang: string } }) {
  const session = await authOrSignIn();

  const history = await getUserPaymentHistory(session.user.id);
  const items = await Promise.all(history.map(async item => {
    const p1 = prisma.package.findFirst({
      where: {
        id: item.packageId,
      },
      select: {
        name: true,
        displayName: true,
        user: {
          select: {
            name: true,
            Profile: {
              select: {
                displayName: true,
              }
            }
          }
        }
      }
    });
    const p2 = stripe.paymentIntents.retrieve(item.paymentId);
    const [pkg, payment] = await Promise.all([p1, p2]);
    return {
      product: pkg ? (pkg.displayName || pkg.name) : "不明なアイテム",
      seller: pkg?.user.Profile?.displayName || pkg?.user.name || "不明なユーザー",
      amount: payment.amount,
      currency: payment.currency,
      paiedAt: item.createdAt,
      id: item.id,
    }
  }))
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:billing.title")}</h2>
      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">{t("account:billing.paymentHistory")}</h3>
        <Separator />
        <ul className="[&_li:last-child]:border-0">
          {items.map((item) => (
            <li className="flex items-center py-4 px-6 gap-2 border-b" key={item.id}>
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
  )
}
import { getTranslation } from "@beutl/i18n";
import { Alert, AlertDescription } from "@beutl/ui/ui/alert";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { authOrSignIn } from "@/lib/auth-guard";
import { buildBillingHistory } from "@/lib/billing-history";
import { syncSubscriptionFromStripe } from "@/lib/stripe/subscription-sync";
import { reconcileAiCheckoutSuccess } from "./actions";
import {
  AiUsageSection,
  PaymentHistorySection,
  PaymentMethodSection,
  PlanSection,
} from "./components";
import { retrieveBillingPage } from "./queries";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    checkout?: string;
    portal?: string;
    session_id?: string;
  }>;
}) {
  const { lang } = await props.params;
  const searchParams = await props.searchParams;
  const session = await authOrSignIn();

  // 下の 2 つは webhook が本命で、これはその先読み。落ちても DB の値でページは
  // 正しく描けるので、握り潰さずに知らせたうえで描画を続ける。
  let stripeUnavailable = false;

  // ポータルでの解約は subscription webhook が届くまで見えない。戻ってきた時点で
  // Stripe を直接読み、ユーザーが今変更した状態をそのまま見せる。
  if (searchParams.portal === "returned") {
    try {
      await syncSubscriptionFromStripe(session.user.id);
    } catch (error) {
      console.error("Could not sync the subscription on portal return", error);
      stripeUnavailable = true;
    }
  }

  let checkoutSuccess = false;
  if (
    searchParams.checkout === "success" &&
    typeof searchParams.session_id === "string"
  ) {
    try {
      checkoutSuccess = await reconcileAiCheckoutSuccess(
        searchParams.session_id,
      );
    } catch (error) {
      console.error("Could not reconcile the AI checkout", error);
      stripeUnavailable = true;
    }
  }

  const { t } = await getTranslation(lang);
  const {
    subscriptions,
    offers,
    aiUsage,
    hasStripeCustomer,
    payments,
    creditPurchases,
    packagesById,
    subscriptionPayments,
    documentByPaymentIntentId,
    billingDocumentsUnavailable,
  } = await retrieveBillingPage(session.user.id);
  const history = buildBillingHistory({
    subscriptionPayments,
    payments,
    creditPurchases,
    packagesById,
    documentByPaymentIntentId,
    t,
    lang,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("account:billing.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("account:billing.description")}
        </p>
      </div>

      {checkoutSuccess && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            {t("account:aiPlan.checkoutSuccess")}
          </AlertDescription>
        </Alert>
      )}
      {(stripeUnavailable || billingDocumentsUnavailable) && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t("account:billing.stripeUnavailableNotice")}
          </AlertDescription>
        </Alert>
      )}

      <PlanSection
        lang={lang}
        t={t}
        subscriptions={subscriptions}
        offers={offers}
      />
      <AiUsageSection lang={lang} t={t} usage={aiUsage} />
      <PaymentMethodSection t={t} hasStripeCustomer={hasStripeCustomer} />
      <PaymentHistorySection lang={lang} t={t} entries={history} />
    </div>
  );
}

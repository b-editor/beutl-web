import { getTranslation } from "@beutl/i18n";
import { Alert, AlertDescription } from "@beutl/ui/ui/alert";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { authOrSignIn } from "@/lib/auth-guard";
import { buildBillingHistory } from "@/lib/billing-history";
import { syncSubscriptionFromStripe } from "@/lib/stripe/subscription-sync";
import { SUBSCRIPTION_PLAN_IDS } from "@beutl/core";
import { reconcileAiCheckoutSuccess } from "./actions";
import { reconcileStorageCheckoutSuccess } from "./storage-actions";
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
    tier?: string;
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
    // 同じ顧客にプランごとの契約があり得るので、全プランを読む。
    const results = await Promise.allSettled(
      SUBSCRIPTION_PLAN_IDS.map((planId) =>
        syncSubscriptionFromStripe(session.user.id, planId),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Could not sync a subscription on portal return", result.reason);
        stripeUnavailable = true;
      }
    }
  }

  let checkoutSuccess = false;
  if (
    (searchParams.checkout === "success" ||
      searchParams.checkout === "storage-success") &&
    typeof searchParams.session_id === "string"
  ) {
    try {
      checkoutSuccess =
        searchParams.checkout === "storage-success"
          ? await reconcileStorageCheckoutSuccess(searchParams.session_id)
          : await reconcileAiCheckoutSuccess(searchParams.session_id);
    } catch (error) {
      console.error("Could not reconcile the checkout", error);
      stripeUnavailable = true;
    }
  }
  const tierNotice =
    searchParams.tier === "changed"
      ? ("changed" as const)
      : searchParams.tier === "failed"
        ? ("failed" as const)
        : searchParams.tier === "over-quota"
          ? ("over-quota" as const)
          : null;

  const { t } = await getTranslation(lang);
  const {
    subscriptions,
    offers,
    aiUsage,
    storageQuota,
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
      {tierNotice === "changed" && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            {t("account:storagePlan.tierChanged")}
          </AlertDescription>
        </Alert>
      )}
      {(tierNotice === "failed" || tierNotice === "over-quota") && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t(
              tierNotice === "failed"
                ? "account:storagePlan.tierChangeFailed"
                : "account:storagePlan.downgradeBlocked",
            )}
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
        storageQuota={storageQuota}
      />
      <AiUsageSection lang={lang} t={t} usage={aiUsage} />
      <PaymentMethodSection t={t} hasStripeCustomer={hasStripeCustomer} />
      <PaymentHistorySection lang={lang} t={t} entries={history} />
    </div>
  );
}

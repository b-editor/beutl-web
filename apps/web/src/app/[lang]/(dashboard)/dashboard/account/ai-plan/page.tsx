import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { getEntitlements } from "@beutl/api";
import { syncSubscriptionFromStripe } from "@/lib/stripe/subscription-sync";
import { Separator } from "@beutl/ui/ui/separator";
import { Button } from "@beutl/ui/ui/button";
import { Progress } from "@beutl/ui/ui/progress";
import { getAiPlanPresentation } from "@/lib/ai-plan-presentation";
import {
  createBillingPortalLink,
  createCreditCheckout,
  createProCheckout,
  reconcileAiCheckoutSuccess,
} from "./actions";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    checkout?: string;
    portal?: string;
    session_id?: string;
  }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const { lang } = params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);

  // A portal cancellation is only visible once Stripe delivers the subscription
  // webhook. Read Stripe directly on the way back so the plan state the user
  // just changed is what they see.
  if (searchParams.portal === "returned") {
    await syncSubscriptionFromStripe(session.user.id);
  }

  const checkoutSuccess =
    searchParams.checkout === "success" &&
    typeof searchParams.session_id === "string" &&
    (await reconcileAiCheckoutSuccess(searchParams.session_id));
  const entitlements = await getEntitlements(session.user.id);
  const isActive = entitlements.canUseAi;
  const presentation = getAiPlanPresentation(entitlements);
  const canManageSubscription = presentation.canManageSubscription;
  const usagePercent = entitlements.balance.monthlyUsage.usedPercent;
  const remainingPercent = entitlements.balance.monthlyUsage.remainingPercent;

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:aiPlan.title")}</h2>
      <p className="mt-2 text-foreground/70">
        {t("account:aiPlan.description")}
      </p>

      {checkoutSuccess && (
        <div className="mt-4 rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-4 text-sm">
          {t("account:aiPlan.checkoutSuccess")}
        </div>
      )}

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:aiPlan.plan")}
        </h3>
        <Separator />
        <div className="py-4 px-6 flex items-center justify-between gap-4">
          <div>
            <p className="font-bold text-lg">
              {isActive
                ? t("account:aiPlan.pro")
                : t("account:aiPlan.free")}
            </p>
            <p className="text-foreground/70 text-sm">
              {t("account:aiPlan.status")}: {" "}
              {presentation.status === "cancelScheduled"
                ? t("account:aiPlan.statusCancelScheduled")
                : presentation.status === "active"
                  ? t("account:aiPlan.statusActive")
                  : presentation.status === "canceled"
                    ? t("account:aiPlan.statusCanceled")
                    : presentation.status === "needsAttention"
                      ? t("account:aiPlan.statusNeedsAttention")
                      : t("account:aiPlan.statusNone")}
            </p>
            {presentation.showCurrentPeriodEnd && entitlements.currentPeriodEnd && (
              <p className="text-foreground/70 text-sm">
                {presentation.status === "cancelScheduled"
                  ? t("account:aiPlan.accessEndsOn")
                  : t("account:aiPlan.nextBillingDate")}
                : {" "}
                {new Date(entitlements.currentPeriodEnd).toLocaleDateString(
                  lang === "ja" ? "ja-JP" : "en-US",
                )}
              </p>
            )}
            {presentation.showCancellationNotice && (
              <p className="mt-1 text-amber-600 dark:text-amber-500 text-sm">
                {t("account:aiPlan.cancelScheduledNotice")}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {!canManageSubscription && (
              <form action={createProCheckout}>
                <Button type="submit">{t("account:aiPlan.joinPro")}</Button>
              </form>
            )}
            {canManageSubscription && (
              <form action={createBillingPortalLink}>
                <Button type="submit" variant="outline">
                  {t("account:aiPlan.manageSubscription")}
                </Button>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:aiPlan.usageAndCredits")}
        </h3>
        <Separator />
        <div className="py-4 px-6 flex items-center justify-between gap-4">
          <div className="flex-1 max-w-md">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-foreground/70 text-sm">
                {t("account:aiPlan.monthlyUsage")}
              </p>
              <p className="font-bold text-2xl">{usagePercent}%</p>
            </div>
            <Progress
              className="mt-2"
              value={usagePercent}
              aria-label={t("account:aiPlan.monthlyUsage")}
            />
            <p className="mt-2 text-foreground/70 text-sm">
              {isActive
                ? t("account:aiPlan.monthlyUsageHint", {
                    percent: remainingPercent,
                  })
                : t("account:aiPlan.monthlyUsageInactive")}
            </p>
            {entitlements.balance.additionalCredits > 0 && (
              <div className="mt-3 flex items-baseline justify-between gap-4">
                <p className="text-foreground/70 text-sm">
                  {t("account:aiPlan.additionalCredits")}
                </p>
                <p className="font-bold text-lg">
                  {entitlements.balance.additionalCredits.toLocaleString(
                    lang === "ja" ? "ja-JP" : "en-US",
                  )}
                </p>
              </div>
            )}
            {entitlements.balance.additionalCredits > 0 && (
              <p className="mt-1 text-foreground/70 text-sm">
                {t("account:aiPlan.additionalCreditsAvailable")}
              </p>
            )}
            {entitlements.balance.hasAdditionalCreditDebt && (
              <p className="mt-1 text-amber-600 dark:text-amber-500 text-sm">
                {t("account:aiPlan.additionalCreditDebtNotice")}
              </p>
            )}
          </div>
          {isActive && (
            <form action={createCreditCheckout}>
              <Button type="submit" variant="outline">
                {t("account:aiPlan.buyCredits")}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

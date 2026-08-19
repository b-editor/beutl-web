// このファイルはサーバーコンポーネントの集まり。account 配下の他ページの
// components.tsx は "use client" だが、請求ページは表示だけでクライアント状態を
// 持たないのでサーバーのまま組む。
import { formatAmount, formatCount, formatDate } from "@beutl/core";
import type { Translator } from "@beutl/i18n";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Badge } from "@beutl/ui/ui/badge";
import { Progress } from "@beutl/ui/ui/progress";
import { Separator } from "@beutl/ui/ui/separator";
import SubmitButton from "@beutl/ui/submit-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/dashboard/section-card";
import type { BillingHistoryEntry } from "@/lib/billing-history";
import { formatBillingProductLabel } from "@/lib/billing-product";
import type { AiPlanStatusPresentation } from "@/lib/ai-plan-presentation";
import {
  createBillingPortalLink,
  createCreditCheckout,
  createPaymentMethodPortalLink,
  createProCheckout,
} from "./actions";
import type {
  BillingOfferEntry,
  BillingSubscriptionEntry,
} from "./queries";

const STATUS_LABEL_KEY: Record<AiPlanStatusPresentation, string> = {
  active: "account:aiPlan.statusActive",
  cancelScheduled: "account:aiPlan.statusCancelScheduled",
  canceled: "account:aiPlan.statusCanceled",
  needsAttention: "account:aiPlan.statusNeedsAttention",
  none: "account:aiPlan.statusNone",
};

function statusVariant(status: AiPlanStatusPresentation) {
  if (status === "needsAttention") return "destructive" as const;
  if (status === "active") return "default" as const;
  return "secondary" as const;
}

// 表の桁が揃わないと金額の比較ができないので、セル側で余白を持つ Table に
// カードの左右パディングを合わせる。
const EDGE_CELL = "first:pl-6 last:pr-6";

// 顧客単位でポータルを開く。1ユーザーが複数の商品を契約できるようになったら、
// 行ごとに subscription_cancel の flow_data で対象を指定する必要がある。
function ManageSubscriptionButton({ t }: { t: Translator }) {
  return (
    <form action={createBillingPortalLink}>
      <SubmitButton variant="outline">
        {t("account:aiPlan.manageSubscription")}
      </SubmitButton>
    </form>
  );
}

export function PlanSection({
  lang,
  t,
  subscriptions,
  offers,
}: {
  lang: string;
  t: Translator;
  subscriptions: BillingSubscriptionEntry[];
  offers: BillingOfferEntry[];
}) {
  const needsAttention = subscriptions.some(
    (subscription) => subscription.status === "needsAttention",
  );

  return (
    <SectionCard title={t("account:aiPlan.plan")}>
      <div className="flex flex-col gap-4">
        {needsAttention && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("account:billing.paymentActionRequired")}</AlertTitle>
            <AlertDescription>
              {t("account:billing.paymentActionRequiredNotice")}
            </AlertDescription>
          </Alert>
        )}

        {subscriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("account:billing.noSubscriptions")}
          </p>
        ) : (
          subscriptions.map((subscription) => (
            <div
              key={subscription.product}
              className="flex flex-wrap items-start justify-between gap-4"
            >
              {/* flex-1 min-w-0 が無いと、解約予告のような長い文でこの列が広がり、
                  管理ボタンが下段に回り込む。 */}
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex items-center gap-3">
                  <p className="text-lg font-bold">
                    {formatBillingProductLabel(t, subscription.product)}
                  </p>
                  <Badge variant={statusVariant(subscription.status)}>
                    {t(STATUS_LABEL_KEY[subscription.status])}
                  </Badge>
                </div>
                {subscription.currentPeriodEnd && (
                  <p className="text-sm text-muted-foreground">
                    {subscription.status === "cancelScheduled"
                      ? t("account:aiPlan.accessEndsOn")
                      : t("account:aiPlan.nextBillingDate")}
                    : {formatDate(subscription.currentPeriodEnd, lang)}
                  </p>
                )}
                {subscription.showCancellationNotice && (
                  <p className="mt-1 text-sm text-amber-600 dark:text-amber-500">
                    {t("account:aiPlan.cancelScheduledNotice")}
                  </p>
                )}
              </div>
              <ManageSubscriptionButton t={t} />
            </div>
          ))
        )}

        {offers.length > 0 && (
          <>
            {/* 契約一覧 (空状態を含む) と加入できる商品の区切り。 */}
            <Separator />
            {offers.map((offer) => (
              <div
                key={offer.product}
                className="flex flex-wrap items-center justify-between gap-4"
              >
                <p className="font-bold">
                  {formatBillingProductLabel(t, offer.product)}
                </p>
                <form action={createProCheckout}>
                  <SubmitButton>{t("account:aiPlan.subscribe")}</SubmitButton>
                </form>
              </div>
            ))}
          </>
        )}
      </div>
    </SectionCard>
  );
}

export function AiUsageSection({
  lang,
  t,
  usage,
}: {
  lang: string;
  t: Translator;
  usage: {
    canUseAi: boolean;
    monthlyUsage: { usedPercent: number; remainingPercent: number };
    additionalCredits: number;
    hasAdditionalCreditDebt: boolean;
  };
}) {
  return (
    <SectionCard title={t("account:billing.aiUsage")}>
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t("account:aiPlan.monthlyUsage")}
        </p>
        <p className="text-2xl font-bold">{usage.monthlyUsage.usedPercent}%</p>
      </div>
      <Progress
        className="mt-2"
        value={usage.monthlyUsage.usedPercent}
        max={100}
        aria-label={t("account:aiPlan.monthlyUsage")}
      />
      <p className="mt-2 text-sm text-muted-foreground">
        {usage.canUseAi
          ? t("account:aiPlan.monthlyUsageHint", {
              percent: usage.monthlyUsage.remainingPercent,
            })
          : t("account:aiPlan.monthlyUsageInactive")}
      </p>

      {/* 残高 0 でも出す。今いくら持っているか見えないと購入の判断ができない。
          購入ボタンは残高のすぐ隣に置く。 */}
      {usage.canUseAi && (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {t("account:aiPlan.additionalCredits")}
            </p>
            <div className="flex items-center gap-4">
              <p className="text-lg font-bold">
                {formatCount(usage.additionalCredits, lang)}
              </p>
              <form action={createCreditCheckout}>
                <SubmitButton variant="outline">
                  {t("account:aiPlan.buyCredits")}
                </SubmitButton>
              </form>
            </div>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("account:aiPlan.additionalCreditsAvailable")}
          </p>
        </>
      )}

      {/* Pro を離れた後も債務は残るので、契約の有無によらず知らせる。 */}
      {usage.hasAdditionalCreditDebt && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">
          {t("account:aiPlan.additionalCreditDebtNotice")}
        </p>
      )}
    </SectionCard>
  );
}

export function PaymentMethodSection({
  t,
  hasStripeCustomer,
}: {
  t: Translator;
  hasStripeCustomer: boolean;
}) {
  return (
    <SectionCard
      title={t("account:billing.paymentMethod")}
      description={t("account:billing.paymentMethodDescription")}
      headerAction={
        // 顧客がまだ無い人にも出す。ポータルの payment_method_update フローは
        // 1 枚目のカードを登録する画面でもあるので、初回の登録もここから通る。
        <form action={createPaymentMethodPortalLink}>
          <SubmitButton variant="outline">
            {t("account:billing.changePaymentMethod")}
          </SubmitButton>
        </form>
      }
    >
      {hasStripeCustomer ? undefined : (
        <p className="text-sm text-muted-foreground">
          {t("account:billing.noPaymentMethodYet")}
        </p>
      )}
    </SectionCard>
  );
}

export function PaymentHistorySection({
  lang,
  t,
  entries,
}: {
  lang: string;
  t: Translator;
  entries: BillingHistoryEntry[];
}) {
  return (
    <SectionCard
      title={t("account:billing.paymentHistory")}
      description={t("account:billing.paymentHistoryDescription")}
      flush
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={EDGE_CELL}>
              {t("account:billing.historyDate")}
            </TableHead>
            <TableHead className={EDGE_CELL}>
              {t("account:billing.historyItem")}
            </TableHead>
            <TableHead className={`${EDGE_CELL} text-right`}>
              {t("account:billing.historyAmount")}
            </TableHead>
            <TableHead className={`${EDGE_CELL} text-right`}>
              {t("account:billing.historyDocument")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className={EDGE_CELL}>
                <p>{t("account:billing.paymentHistoryEmpty")}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("account:billing.paymentHistoryEmptyHint")}
                </p>
              </TableCell>
            </TableRow>
          ) : (
            entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell
                  className={`${EDGE_CELL} whitespace-nowrap align-top text-muted-foreground`}
                  title={entry.paidAt.toISOString()}
                >
                  {formatDate(entry.paidAt, lang)}
                </TableCell>
                <TableCell className={`${EDGE_CELL} align-top`}>
                  <p className="font-bold">{entry.product}</p>
                  {entry.detail && (
                    <p className="text-sm text-muted-foreground">
                      {entry.detail}
                    </p>
                  )}
                  {entry.reversalNote && (
                    <p className="text-sm text-amber-600 dark:text-amber-500">
                      {entry.reversalNote}
                    </p>
                  )}
                </TableCell>
                <TableCell
                  className={`${EDGE_CELL} whitespace-nowrap text-right align-top tabular-nums`}
                  title={
                    entry.amount
                      ? undefined
                      : t("account:billing.amountUnavailableLabel")
                  }
                >
                  {entry.amount
                    ? formatAmount(entry.amount.value, entry.amount.currency, lang)
                    : "—"}
                </TableCell>
                <TableCell
                  className={`${EDGE_CELL} whitespace-nowrap text-right align-top`}
                >
                  {entry.document ? (
                    <a
                      className="inline-flex items-center gap-1 underline underline-offset-4"
                      href={entry.document.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t(
                        entry.document.kind === "invoice"
                          ? "account:billing.viewInvoice"
                          : "account:billing.viewReceipt",
                      )}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

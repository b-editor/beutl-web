"use client";

import { formatCount, formatDate } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@beutl/ui/ui/collapsible";
import { Progress } from "@beutl/ui/ui/progress";
import { useToast } from "@beutl/ui/use-toast";
import {
  ChevronRight,
  Copy,
  Download,
  Lock,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

// The field name the AI server actions read the idempotency key from. The v3
// API takes the same value in an Idempotency-Key header; a Server Action has no
// header the caller controls, so it travels as a form field.
export const IDEMPOTENCY_KEY_FIELD = "idempotencyKey";

// What the server decided about this user's plan and balance. `availability` is
// keyed by operation and already accounts for the monthly allowance, purchased
// credits and the configured unit price, so the client never has to know what
// an operation costs.
export type AiAccess = {
  canUseAi: boolean;
  availability: Record<string, boolean>;
};

export type AiBalance = {
  usedPercent: number;
  remainingPercent: number;
  isExhausted: boolean;
  additionalCredits: number;
  hasAdditionalCreditDebt: boolean;
  // The end of the current billing period, when the monthly allowance resets —
  // or, when `endsAtPeriodEnd` is true, when the plan stops instead.
  periodEnd: string | null;
  endsAtPeriodEnd: boolean;
};

export type AiBlockReason = "plan" | "balance";

// A screen is usable when at least one of the operations it offers can be
// started. The image editor offers five, and running out of balance for the
// most expensive one should not hide the others. A screen that starts no
// operation at all — the history — only needs the plan.
export function blockedReason(
  access: AiAccess,
  operations: readonly string[],
): AiBlockReason | null {
  if (!access.canUseAi) return "plan";
  if (
    operations.length === 0 ||
    operations.some((operation) => access.availability[operation])
  ) {
    return null;
  }
  return "balance";
}

export function billingHref(lang: string): string {
  return `/${lang}/dashboard/account/billing`;
}

export function AiPageHeader({
  lang,
  title,
  description,
  balance,
}: {
  lang: string;
  title: string;
  description: string;
  // Shown alongside the title because the remaining allowance is what decides
  // whether the work about to be described on this page can run at all.
  balance?: AiBalance;
}) {
  const { t } = useTranslation(lang);
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link
          href={`/${lang}/dashboard/ai`}
          className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className="mr-1 h-4 w-4 rotate-180" />
          {t("dashboard:ai.backToAi")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {balance && (
        <Link
          href={`/${lang}/dashboard/ai`}
          className="w-44 rounded-lg border bg-card p-3 text-card-foreground transition-colors hover:bg-accent/50"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t("dashboard:ai.monthlyUsage")}
            </span>
            <span className="text-sm font-bold tabular-nums">
              {balance.usedPercent}%
            </span>
          </div>
          <Progress
            className={`mt-1.5 h-2 ${usageToneClass(balance)}`}
            value={balance.usedPercent}
            max={100}
            aria-label={t("dashboard:ai.monthlyUsage")}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("account:aiPlan.additionalCredits")}:{" "}
            {formatCount(balance.additionalCredits, lang)}
          </p>
        </Link>
      )}
    </div>
  );
}

// Why a screen cannot be used, and the one link that resolves it. Both cases
// are dead ends without a way out: subscribing and buying credits both happen
// on the billing page.
export function AiAccessNotice({
  lang,
  reason,
}: {
  lang: string;
  reason: AiBlockReason;
}) {
  const { t } = useTranslation(lang);
  const isPlan = reason === "plan";
  return (
    <Alert variant={isPlan ? "default" : "destructive"}>
      {isPlan ? (
        <Lock className="h-4 w-4" />
      ) : (
        <TriangleAlert className="h-4 w-4" />
      )}
      <AlertTitle>
        {isPlan
          ? t("dashboard:ai.planRequiredTitle")
          : t("dashboard:ai.balanceExhaustedTitle")}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>
          {isPlan
            ? t("dashboard:ai.planRequired")
            : t("dashboard:ai.balanceExhaustedDescription")}
        </span>
        <Button asChild size="sm" variant={isPlan ? "default" : "outline"}>
          <Link href={billingHref(lang)}>
            {isPlan
              ? t("account:aiPlan.joinPro")
              : t("account:aiPlan.buyCredits")}
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function usageToneClass(balance: AiBalance): string {
  if (balance.isExhausted) return "[&>div]:bg-destructive";
  if (balance.usedPercent >= 80) return "[&>div]:bg-amber-500";
  return "";
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <p className="truncate text-2xl font-bold">{value}</p>
    </div>
  );
}

// The allowance is the one number that decides whether an AI screen will work,
// so it leads every AI page rather than living only on the billing page. The
// three figures sit side by side because a single label-and-value row leaves the
// middle of a full-width card empty.
export function AiUsageCard({
  lang,
  balance,
}: {
  lang: string;
  balance: AiBalance;
}) {
  const { t } = useTranslation(lang);
  return (
    <Card className="p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label={t("dashboard:ai.monthlyUsage")}
          value={`${balance.usedPercent}%`}
        />
        <Stat
          label={t("account:aiPlan.additionalCredits")}
          value={formatCount(balance.additionalCredits, lang)}
        />
        {balance.periodEnd && (
          <Stat
            label={t(
              balance.endsAtPeriodEnd
                ? "dashboard:ai.planEnds"
                : "dashboard:ai.nextReset",
            )}
            value={formatDate(balance.periodEnd, lang)}
          />
        )}
      </div>

      <Progress
        className={`mt-4 ${usageToneClass(balance)}`}
        value={balance.usedPercent}
        max={100}
        aria-label={t("dashboard:ai.monthlyUsage")}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground">
          {balance.isExhausted
            ? t("dashboard:ai.monthlyUsageExhausted")
            : t("account:aiPlan.monthlyUsageHint", {
                percent: balance.remainingPercent,
              })}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={billingHref(lang)}>{t("account:aiPlan.buyCredits")}</Link>
        </Button>
      </div>

      {balance.hasAdditionalCreditDebt && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">
          {t("account:aiPlan.additionalCreditDebtNotice")}
        </p>
      )}
    </Card>
  );
}

// One submission is one attempt, and every arrival of that attempt at the server
// — a double click, a retried POST, a second tab — would otherwise reserve and
// charge again. The key identifies the attempt so duplicates collapse onto the
// first job.
//
// It is generated after mount rather than during render: a value produced on the
// server would either differ from the hydrated one or, if derived from the tree,
// repeat across page loads and collide with an unrelated attempt. It rotates when
// the action settles, so the next deliberate run is a new attempt.
export function IdempotencyKeyField({ state }: { state: unknown }) {
  const [key, setKey] = useState("");

  useEffect(() => {
    setKey(crypto.randomUUID());
  }, [state]);

  return <input type="hidden" name={IDEMPOTENCY_KEY_FIELD} value={key} />;
}

// Input on the left, what the run produced on the right. Splitting them fills
// the width a single column left empty and puts a fresh result on screen
// without scrolling past the form that made it. Omitting `result` gives the
// one-column form used by screens that produce nothing inline.
export function AiWorkspace({
  form,
  result,
}: {
  form: ReactNode;
  result?: ReactNode;
}) {
  if (!result) {
    return <div className="max-w-4xl">{form}</div>;
  }
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {form}
      {result}
    </div>
  );
}

// Holds the right column open before the first run so the form does not jump
// sideways when a result arrives. Hidden where the columns stack, since there
// it would only push the form off screen.
export function ResultPlaceholder({
  icon: Icon,
  label,
}: {
  icon: typeof Sparkles;
  label: string;
}) {
  return (
    <div className="hidden min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center lg:flex">
      <Icon className="h-8 w-8 text-muted-foreground/60" />
      <p className="max-w-xs text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

// Optional prompt refinements are what a first-time visitor should not have to
// read past to reach the submit button, but they are also what a returning user
// reaches for every time — hence collapsed, not hidden.
export function AdvancedOptions({
  lang,
  children,
  defaultOpen = false,
}: {
  lang: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation(lang);
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/advanced">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
        >
          <ChevronRight className="mr-1 h-4 w-4 transition-transform duration-200 group-data-[state=open]/advanced:rotate-90" />
          {t("dashboard:ai.advancedOptions")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 pt-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function downloadTextFile(
  text: string,
  filename: string,
  mimeType = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking on this tick aborts the download on a browser that does not start
  // it synchronously inside click().
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Generated media is served from this origin's authenticated content route, so
// the browser honours `download` and the file lands with a usable name instead
// of opening in a tab.
export function downloadFromUrl(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

export function CopyButton({
  lang,
  text,
  label,
}: {
  lang: string;
  text: () => string;
  label?: string;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setCopied(true);
          // Long enough to read, short enough that the button is ready again
          // before a second copy.
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          toast({
            title: t("dashboard:ai.copyFailed"),
            variant: "destructive",
          });
        }
      }}
    >
      <Copy className="mr-2 h-4 w-4" />
      {copied ? t("dashboard:ai.copied") : (label ?? t("dashboard:ai.copy"))}
    </Button>
  );
}

export function DownloadButton({
  label,
  onDownload,
}: {
  label: string;
  onDownload: () => void;
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onDownload}>
      <Download className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

// A finished result is the moment the screen has something to say, and it owns
// the right column. It carries the same weight as the form card rather than
// reading as one more field inside it.
export function ResultPanel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 font-bold">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          {title}
        </p>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}

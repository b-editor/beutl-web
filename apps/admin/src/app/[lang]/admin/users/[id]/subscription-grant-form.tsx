"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@beutl/ui/ui/alert-dialog";
import {
  SUBSCRIPTION_GRANT_MONTH_OPTIONS,
  SUBSCRIPTION_GRANT_REASON_MAX_LENGTH,
  type ActionResult,
} from "@beutl/core";
import { grantSubscription, revokeGrantedSubscription } from "./actions";

export type SubscriptionGrantPlanOption = {
  // Select の値。planId と tier を 1 つにしたもの。
  value: string;
  label: string;
  planId: string;
  tier: string | null;
};

// 値は React が描画時にエスケープするので、i18next には二重にエスケープさせない。
const RAW = { interpolation: { escapeValue: false } } as const;

const TERM_UNTIL = "until";
const TERM_INDEFINITE = "indefinite";

function ConfirmButton({
  lang,
  label,
  confirmLabel,
  title,
  description,
  disabled,
  variant,
  onConfirm,
}: {
  lang: string;
  label: string;
  confirmLabel: string;
  title: string;
  description: string;
  disabled: boolean;
  variant?: "default" | "outline";
  onConfirm: () => void;
}) {
  const { t } = useTranslation(lang);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={variant} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("admin:common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// 結果を toast に出し、成否にかかわらずサーバーの状態を取り直す。
function useGrantAction(lang: string, messages: { success: string; failed: string }) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const run = useCallback(
    (action: () => Promise<ActionResult>, onSuccess?: () => void) => {
      startTransition(async () => {
        try {
          const res = await action();
          if (res.success) {
            onSuccess?.();
            toast({ title: t(messages.success) });
          } else {
            toast({
              title: t(messages.failed),
              description: res.message,
              variant: "destructive",
            });
          }
        } catch (e) {
          toast({
            title: t(messages.failed),
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
        router.refresh();
      });
    },
    [toast, t, router, messages.success, messages.failed],
  );
  return { isPending, run };
}

// "YYYY-MM-DD" を、このブラウザのタイムゾーンでその日が終わる時刻 (翌日の 0 時) に
// 直す。管理者が「12/31 まで」と選んだら 12/31 いっぱい使えるようにする。
function endOfLocalDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day + 1);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function SubscriptionGrantForm({
  lang,
  userId,
  planOptions,
}: {
  lang: string;
  userId: string;
  planOptions: SubscriptionGrantPlanOption[];
}) {
  const { t } = useTranslation(lang);
  const { isPending, run } = useGrantAction(lang, {
    success: "admin:users.grants.success",
    failed: "admin:users.grants.failed",
  });
  const [planValue, setPlanValue] = useState(planOptions[0]?.value ?? "");
  const [termValue, setTermValue] = useState(
    String(SUBSCRIPTION_GRANT_MONTH_OPTIONS[0]),
  );
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");

  const plan = planOptions.find((option) => option.value === planValue);
  const endsAt = termValue === TERM_UNTIL ? endOfLocalDay(endDate) : null;
  // 過去の日付はサーバーが弾く (描画のたびに現在時刻と比べない)。
  const term =
    termValue === TERM_INDEFINITE
      ? ({ kind: "indefinite" } as const)
      : termValue === TERM_UNTIL
        ? endsAt
          ? ({ kind: "until", endsAt: endsAt.toISOString() } as const)
          : null
        : ({ kind: "months", months: Number(termValue) } as const);
  const termLabel =
    term === null
      ? ""
      : term.kind === "indefinite"
        ? t("admin:users.grants.termIndefinite")
        : term.kind === "until"
          ? `${t("admin:users.grants.endDate")} ${endDate}`
          : t("admin:users.grants.termMonths", { count: term.months });
  const trimmedReason = reason.trim();
  const valid =
    plan !== undefined &&
    term !== null &&
    trimmedReason.length > 0 &&
    trimmedReason.length <= SUBSCRIPTION_GRANT_REASON_MAX_LENGTH;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="subscription-grant-plan">
            {t("admin:users.grants.plan")}
          </Label>
          <Select
            value={planValue}
            onValueChange={setPlanValue}
            disabled={isPending}
          >
            <SelectTrigger id="subscription-grant-plan" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {planOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="subscription-grant-term">
            {t("admin:users.grants.term")}
          </Label>
          <Select
            value={termValue}
            onValueChange={setTermValue}
            disabled={isPending}
          >
            <SelectTrigger id="subscription-grant-term" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBSCRIPTION_GRANT_MONTH_OPTIONS.map((months) => (
                <SelectItem key={months} value={String(months)}>
                  {t("admin:users.grants.termMonths", { count: months })}
                </SelectItem>
              ))}
              <SelectItem value={TERM_UNTIL}>
                {t("admin:users.grants.termUntil")}
              </SelectItem>
              <SelectItem value={TERM_INDEFINITE}>
                {t("admin:users.grants.termIndefinite")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {termValue === TERM_UNTIL && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="subscription-grant-end-date">
            {t("admin:users.grants.endDate")}
          </Label>
          <Input
            id="subscription-grant-end-date"
            type="date"
            className="w-48"
            value={endDate}
            disabled={isPending}
            onChange={(e) => setEndDate(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("admin:users.grants.endDateHint")}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="subscription-grant-reason">
          {t("admin:users.grants.reason")}
        </Label>
        <Textarea
          id="subscription-grant-reason"
          rows={2}
          maxLength={SUBSCRIPTION_GRANT_REASON_MAX_LENGTH}
          placeholder={t("admin:users.grants.reasonPlaceholder")}
          value={reason}
          disabled={isPending}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <div>
        <ConfirmButton
          lang={lang}
          label={t("admin:users.grants.submit")}
          confirmLabel={t("admin:users.grants.submit")}
          title={t("admin:users.grants.confirmTitle")}
          description={t("admin:users.grants.confirmDescription", {
            plan: plan?.label ?? "",
            term: termLabel,
            ...RAW,
          })}
          disabled={isPending || !valid}
          onConfirm={() => {
            if (!plan || term === null) return;
            run(
              () =>
                grantSubscription({
                  userId,
                  planId: plan.planId,
                  tier: plan.tier,
                  term,
                  reason: trimmedReason,
                }),
              () => {
                setReason("");
                setEndDate("");
              },
            );
          }}
        />
      </div>
    </div>
  );
}

export function RevokeSubscriptionGrantButton({
  lang,
  userId,
  grantId,
  planLabel,
}: {
  lang: string;
  userId: string;
  grantId: string;
  planLabel: string;
}) {
  const { t } = useTranslation(lang);
  const { isPending, run } = useGrantAction(lang, {
    success: "admin:users.grants.revokeSuccess",
    failed: "admin:users.grants.revokeFailed",
  });
  return (
    <ConfirmButton
      lang={lang}
      variant="outline"
      label={t("admin:users.grants.revoke")}
      confirmLabel={t("admin:users.grants.revoke")}
      title={t("admin:users.grants.revokeConfirmTitle")}
      description={t("admin:users.grants.revokeConfirmDescription", {
        plan: planLabel,
        ...RAW,
      })}
      disabled={isPending}
      onConfirm={() =>
        run(() => revokeGrantedSubscription({ userId, grantId }))
      }
    />
  );
}

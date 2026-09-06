"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
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
import { randomUuid, type ActionResult } from "@beutl/core";
import { adjustAiCredits, setAiMonthlyUsage } from "./actions";

function ConfirmButton({
  lang,
  label,
  title,
  description,
  disabled,
  variant,
  onConfirm,
}: {
  lang: string;
  label: string;
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
          <AlertDialogAction onClick={onConfirm}>
            {t("admin:users.aiAdjustApply")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AiPlanAdjustmentForm({
  lang,
  userId,
  canAdjustMonthlyUsage,
  monthlyUsageUsed,
  monthlyUsageLimit,
}: {
  lang: string;
  userId: string;
  canAdjustMonthlyUsage: boolean;
  monthlyUsageUsed: number;
  monthlyUsageLimit: number;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [creditDelta, setCreditDelta] = useState("");
  // 入力されている訂正を一意に識別するキー。同じ訂正が二回届いても付与は一度しか
  // 適用されない。入力が変わるたびに発行し直すため、適用後に空になった欄へ同じ額を
  // 打ち直せば、それは新しい訂正として通る。
  const [creditAdjustmentKey, setCreditAdjustmentKey] = useState(() =>
    randomUuid(),
  );
  const [usageValue, setUsageValue] = useState(String(monthlyUsageUsed));
  // router.refresh() でサーバーの値が変わっても、この入力は初期値のまま残る。
  // 古い値を掴んだまま適用すると、その間に動いた分を無自覚に打ち消してしまう。
  const [syncedUsage, setSyncedUsage] = useState(monthlyUsageUsed);
  if (syncedUsage !== monthlyUsageUsed) {
    setSyncedUsage(monthlyUsageUsed);
    setUsageValue(String(monthlyUsageUsed));
  }

  const run = useCallback(
    (action: () => Promise<ActionResult>, onSuccess?: () => void) => {
      startTransition(async () => {
        try {
          const res = await action();
          if (res.success) {
            onSuccess?.();
            toast({ title: t("admin:users.aiAdjustSuccess") });
          } else {
            toast({
              title: t("admin:users.aiAdjustFailed"),
              description: res.message,
              variant: "destructive",
            });
          }
        } catch (e) {
          toast({
            title: t("admin:users.aiAdjustFailed"),
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
        // 失敗は台帳の書き込み後にも起こりうる。どちらの結果でもサーバーの
        // 残高を取り直して、画面と実際の状態が食い違わないようにする。
        router.refresh();
      });
    },
    [toast, t, router],
  );

  const parsedCreditDelta = Number(creditDelta);
  const creditDeltaValid =
    creditDelta.trim() !== "" &&
    Number.isSafeInteger(parsedCreditDelta) &&
    parsedCreditDelta !== 0;

  const parsedUsage = Number(usageValue);
  const usageValid =
    usageValue.trim() !== "" &&
    Number.isSafeInteger(parsedUsage) &&
    parsedUsage >= 0 &&
    parsedUsage <= monthlyUsageLimit;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="ai-credit-delta" className="text-sm font-semibold">
          {t("admin:users.aiAdjustCredits")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("admin:users.aiAdjustCreditsHint")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="ai-credit-delta"
            type="number"
            step={1}
            className="w-40"
            placeholder="0"
            value={creditDelta}
            disabled={isPending}
            onChange={(e) => {
              setCreditDelta(e.target.value);
              setCreditAdjustmentKey(randomUuid());
            }}
          />
          <ConfirmButton
            lang={lang}
            label={t("admin:users.aiAdjustApply")}
            title={t("admin:users.aiAdjustCreditsConfirmTitle")}
            description={t("admin:users.aiAdjustCreditsConfirmDescription", {
              amount: creditDeltaValid ? parsedCreditDelta : 0,
            })}
            disabled={isPending || !creditDeltaValid}
            onConfirm={() =>
              run(
                () =>
                  adjustAiCredits({
                    userId,
                    creditDelta: parsedCreditDelta,
                    adjustmentKey: creditAdjustmentKey,
                  }),
                () => setCreditDelta(""),
              )
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ai-monthly-usage" className="text-sm font-semibold">
          {t("admin:users.aiAdjustMonthlyUsage")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {canAdjustMonthlyUsage
            ? t("admin:users.aiAdjustMonthlyUsageHint", {
                limit: monthlyUsageLimit,
              })
            : t("admin:users.aiAdjustMonthlyUsageDisabled")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="ai-monthly-usage"
            type="number"
            step={1}
            min={0}
            max={monthlyUsageLimit}
            className="w-40"
            value={usageValue}
            disabled={isPending || !canAdjustMonthlyUsage}
            onChange={(e) => setUsageValue(e.target.value)}
          />
          <ConfirmButton
            lang={lang}
            label={t("admin:users.aiAdjustApply")}
            title={t("admin:users.aiAdjustMonthlyUsageConfirmTitle")}
            description={t(
              "admin:users.aiAdjustMonthlyUsageConfirmDescription",
              { value: usageValid ? parsedUsage : monthlyUsageUsed },
            )}
            disabled={isPending || !canAdjustMonthlyUsage || !usageValid}
            onConfirm={() =>
              run(() =>
                setAiMonthlyUsage({
                  userId,
                  monthlyUsageUsed: parsedUsage,
                  expectedMonthlyUsageUsed: syncedUsage,
                }),
              )
            }
          />
          <ConfirmButton
            lang={lang}
            variant="outline"
            label={t("admin:users.aiResetMonthlyUsage")}
            title={t("admin:users.aiResetMonthlyUsageConfirmTitle")}
            description={t("admin:users.aiResetMonthlyUsageConfirmDescription")}
            disabled={
              isPending || !canAdjustMonthlyUsage || monthlyUsageUsed === 0
            }
            onConfirm={() =>
              run(
                () =>
                  setAiMonthlyUsage({
                    userId,
                    monthlyUsageUsed: 0,
                    expectedMonthlyUsageUsed: syncedUsage,
                  }),
                () => setUsageValue("0"),
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

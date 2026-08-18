"use client";

import {
  AI_OPERATIONS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  aiMinimumChargeOf,
  aiPriceSettingKey,
} from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { TriangleAlert } from "lucide-react";
import { useAiSettingValues } from "./settings-form";

// An operation nobody on the plan can start. Reading the drafts rather than the
// saved values means lowering the allowance warns while it is being typed, in
// step with the per-operation panels below.
export function AiUnaffordableAlert({
  lang,
  // Registered models per operation, saved values only: unlike the settings
  // fields these are not part of the batch being drafted.
  registeredModels,
}: {
  lang: string;
  registeredModels: Record<string, { priceUnits: number; enabled: boolean }[]>;
}) {
  const { t } = useTranslation(lang);
  const values = useAiSettingValues();

  const allowance = Number(
    (values.get(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY) ?? "").trim(),
  );
  if (!Number.isFinite(allowance) || allowance <= 0) {
    return null;
  }

  const unaffordable = AI_OPERATIONS.filter((operation) => {
    // The smallest request the operation accepts, not one billing unit: the
    // shortest video is four seconds, so a quarter of the allowance is already
    // out of reach.
    const exceedsAllowance = (price: number) =>
      Number.isFinite(price) &&
      (aiMinimumChargeOf(operation, price) ?? price) > allowance;

    const enabled = (registeredModels[operation] ?? []).filter(
      (model) => model.enabled,
    );
    if (enabled.length > 0) {
      // Being unable to afford the dearest model is a choice on offer, not a
      // misconfiguration; only losing every one of them takes the operation off.
      return enabled.every((model) => exceedsAllowance(model.priceUnits));
    }
    return exceedsAllowance(
      Number((values.get(aiPriceSettingKey(operation)) ?? "").trim()),
    );
  });
  if (unaffordable.length === 0) {
    return null;
  }

  return (
    <Alert variant="destructive">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{t("admin:ai.plan.unaffordableTitle")}</AlertTitle>
      <AlertDescription>
        {t("admin:ai.plan.unaffordableDescription", {
          limit: allowance,
          operations: unaffordable
            .map((operation) => t(`admin:ai.operation.${operation}`))
            .join(", "),
        })}
      </AlertDescription>
    </Alert>
  );
}

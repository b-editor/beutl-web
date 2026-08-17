"use client";

import {
  AI_OPERATIONS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  aiPriceSettingKey,
} from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { TriangleAlert } from "lucide-react";
import { useAiSettingValues } from "./settings-form";

// A price above the allowance leaves an operation unusable without purchased
// credits. Reading the drafts rather than the saved values means lowering the
// allowance warns while it is being typed, in step with the per-operation
// panels below.
export function AiUnaffordableAlert({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const values = useAiSettingValues();

  const allowance = Number(
    (values.get(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY) ?? "").trim(),
  );
  if (!Number.isFinite(allowance) || allowance <= 0) {
    return null;
  }

  const unaffordable = AI_OPERATIONS.filter((operation) => {
    const price = Number((values.get(aiPriceSettingKey(operation)) ?? "").trim());
    return Number.isFinite(price) && price > allowance;
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

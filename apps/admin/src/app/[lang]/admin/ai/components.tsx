"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Input } from "@beutl/ui/ui/input";
import { Button } from "@beutl/ui/ui/button";
import { Badge } from "@beutl/ui/ui/badge";
import {
  MAX_MONTHLY_USAGE_LIMIT,
  MAX_PRICE_UNITS,
  MIN_MONTHLY_USAGE_LIMIT,
  MIN_PRICE_UNITS,
} from "@beutl/core";
import { useAiSettingField, type AiSettingRow } from "./settings-form";

export type { AiSettingRow };

const LABEL_KEYS = {
  model: "admin:ai.model",
  price: "admin:ai.price",
  limit: "admin:ai.monthlyUsageLimit",
} as const;

const NUMBER_RANGES = {
  price: { min: MIN_PRICE_UNITS, max: MAX_PRICE_UNITS },
  limit: { min: MIN_MONTHLY_USAGE_LIMIT, max: MAX_MONTHLY_USAGE_LIMIT },
} as const;

function SourceBadge({
  lang,
  source,
  reset,
}: {
  lang: string;
  source: AiSettingRow["source"];
  reset: boolean;
}) {
  const { t } = useTranslation(lang);
  if (reset || source === "default") {
    return <Badge variant="outline">{t("admin:ai.source.default")}</Badge>;
  }
  return <Badge variant="default">{t("admin:ai.source.database")}</Badge>;
}

// The field holds no save button of its own: every setting on this page is
// committed together by the bar in AiSettingsForm, because repricing usually
// means touching several at once.
export function AiSettingField({
  lang,
  settingKey,
}: {
  lang: string;
  settingKey: string;
}) {
  const { t } = useTranslation(lang);
  const { setting, value, reset, changed, isPending, setValue, markReset } =
    useAiSettingField(settingKey);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t(LABEL_KEYS[setting.kind])}</span>
        <SourceBadge lang={lang} source={setting.source} reset={reset} />
        {changed && (
          <Badge variant="secondary">{t("admin:ai.form.unsaved")}</Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          disabled={isPending}
          onChange={(e) => setValue(e.target.value)}
          {...(setting.kind === "model"
            ? { className: "min-w-64 flex-1" }
            : {
                type: "number",
                min: NUMBER_RANGES[setting.kind].min,
                max: NUMBER_RANGES[setting.kind].max,
                step: 1,
                className: "w-32",
              })}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={isPending || (reset ? true : setting.source !== "database")}
          onClick={markReset}
        >
          {t("admin:ai.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("admin:ai.defaultValue")}: <code>{setting.fallback}</code>
      </p>
    </div>
  );
}

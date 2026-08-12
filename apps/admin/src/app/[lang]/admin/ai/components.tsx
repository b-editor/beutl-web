"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetAiSetting, updateAiSetting } from "./actions";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Input } from "@beutl/ui/ui/input";
import { Button } from "@beutl/ui/ui/button";
import { Badge } from "@beutl/ui/ui/badge";
import { MAX_PRICE_UNITS, MIN_PRICE_UNITS } from "@beutl/core";

export type AiSettingRow = {
  key: string;
  kind: "model" | "price";
  value: string;
  source: "database" | "environment" | "default";
  envVar?: string;
  fallback: string;
};

function SourceBadge({ lang, source }: { lang: string; source: AiSettingRow["source"] }) {
  const { t } = useTranslation(lang);
  if (source === "database") {
    return <Badge variant="default">{t("admin:ai.source.database")}</Badge>;
  }
  if (source === "environment") {
    return <Badge variant="secondary">{t("admin:ai.source.environment")}</Badge>;
  }
  return <Badge variant="outline">{t("admin:ai.source.default")}</Badge>;
}

export function AiSettingField({
  lang,
  setting,
}: {
  lang: string;
  setting: AiSettingRow;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(setting.value);
  // 保存が失敗したときの戻り先。setting.value は再描画されるまで古いままなので、
  // 直近で永続化に成功した値を保持する。
  const committedValue = useRef(setting.value);

  useEffect(() => {
    // 保存処理の途中で届いた refresh の値は古いサーバー値のことがある。
    // 永続化済みの値と一致する間は同期せず、編集中の入力を守る。
    if (setting.value === committedValue.current) return;
    committedValue.current = setting.value;
    setValue(setting.value);
  }, [setting.value]);

  const notifyFailure = useCallback(
    (message?: string) => {
      setValue(committedValue.current);
      toast({
        title: t("admin:ai.updateFailed"),
        description: message,
        variant: "destructive",
      });
      // 失敗は設定永続化の後 (監査ログ書き込みなど) でも起こりうるため、
      // 直前の値へ戻すだけでなくサーバーの値を取り直す。
      router.refresh();
    },
    [toast, t, router],
  );

  const handleSave = useCallback(() => {
    const nextValue = value.trim();
    if (nextValue === committedValue.current) return;
    startTransition(async () => {
      try {
        const res = await updateAiSetting({ key: setting.key, value: nextValue });
        if (res.success) {
          committedValue.current = nextValue;
          setValue(nextValue);
          toast({ title: t("admin:ai.updateSuccess") });
          router.refresh();
        } else {
          notifyFailure(res.message);
        }
      } catch (e) {
        notifyFailure(e instanceof Error ? e.message : String(e));
      }
    });
  }, [value, setting.key, notifyFailure, toast, t, router]);

  const handleReset = useCallback(() => {
    startTransition(async () => {
      try {
        const res = await resetAiSetting({ key: setting.key });
        if (res.success) {
          toast({ title: t("admin:ai.resetSuccess") });
          router.refresh();
        } else {
          notifyFailure(res.message);
        }
      } catch (e) {
        notifyFailure(e instanceof Error ? e.message : String(e));
      }
    });
  }, [setting.key, notifyFailure, toast, t, router]);

  const isDirty = value.trim() !== committedValue.current;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {setting.kind === "model" ? t("admin:ai.model") : t("admin:ai.price")}
          </span>
          <SourceBadge lang={lang} source={setting.source} />
        </div>
        {setting.envVar ? (
          <code className="text-xs text-muted-foreground">{setting.envVar}</code>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          disabled={isPending}
          onChange={(e) => setValue(e.target.value)}
          {...(setting.kind === "price"
            ? {
                type: "number",
                min: MIN_PRICE_UNITS,
                max: MAX_PRICE_UNITS,
                step: 1,
                className: "w-32",
              }
            : { className: "min-w-64 flex-1" })}
        />
        <Button size="sm" disabled={isPending || !isDirty} onClick={handleSave}>
          {t("admin:ai.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending || setting.source !== "database"}
          onClick={handleReset}
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

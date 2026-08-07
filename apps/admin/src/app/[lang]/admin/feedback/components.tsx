"use client";

import { useCallback, useState, useTransition } from "react";
import { updateStatus } from "./actions";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import type { FeedbackStatus } from "@prisma/client";
import type { ActionResult } from "@beutl/core";

const statuses = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;

export function FeedbackStatusSelect({
  lang,
  feedbackId,
  initialStatus,
}: {
  lang: string;
  feedbackId: string;
  initialStatus: FeedbackStatus;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<FeedbackStatus>(initialStatus);

  useEffect(() => {
    const state = lastResult;
    if (!state) return;
    if (state.success) {
      toast({ title: t("admin:feedback.updateSuccess") });
    } else {
      toast({
        title: t("admin:feedback.updateFailed"),
        description: state.message,
        variant: "destructive",
      });
    }
    setLastResult(null);
  }, [lastResult, toast, t]);

  const handleChange = useCallback((value: string) => {
    const nextStatus = value as FeedbackStatus;
    // 楽観的更新: サーバー応答前に選択値を反映
    setSelectedStatus(nextStatus);
    startTransition(async () => {
      const res = await updateStatus({
        id: feedbackId,
        status: nextStatus,
      });
      if (!res.success) {
        // 失敗時は元の値に戻す
        setSelectedStatus(initialStatus);
      }
      setLastResult(res);
    });
  }, [feedbackId, initialStatus, startTransition]);

  return (
    <Select
      value={selectedStatus}
      disabled={isPending}
      onValueChange={handleChange}
    >
      <SelectTrigger className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {statuses.map((status) => (
          <SelectItem key={status} value={status}>
            {t(`admin:status.${status}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

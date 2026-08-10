"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { updateStatus } from "./actions";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import { statuses } from "./enums";
import type { FeedbackStatus } from "@beutl/db";

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
  const [selectedStatus, setSelectedStatus] = useState<FeedbackStatus>(initialStatus);
  // 更新が失敗したときの戻り先。initialStatus は再描画されるまで古いままなので、
  // 直近で永続化に成功した値を保持する。
  const committedStatus = useRef<FeedbackStatus>(initialStatus);

  useEffect(() => {
    committedStatus.current = initialStatus;
    setSelectedStatus(initialStatus);
  }, [initialStatus]);

  const notifyFailure = useCallback(
    (message?: string) => {
      setSelectedStatus(committedStatus.current);
      toast({
        title: t("admin:feedback.updateFailed"),
        description: message,
        variant: "destructive",
      });
    },
    [toast, t],
  );

  const handleChange = useCallback((value: string) => {
    const nextStatus = value as FeedbackStatus;
    setSelectedStatus(nextStatus);
    startTransition(async () => {
      try {
        const res = await updateStatus({
          id: feedbackId,
          status: nextStatus,
        });
        if (res.success) {
          committedStatus.current = nextStatus;
          toast({ title: t("admin:feedback.updateSuccess") });
        } else {
          notifyFailure(res.message);
        }
      } catch (e) {
        notifyFailure(e instanceof Error ? e.message : String(e));
      }
    });
  }, [feedbackId, startTransition, notifyFailure, toast, t]);

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

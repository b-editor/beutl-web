"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateStatus } from "./actions";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedStatus, setSelectedStatus] = useState<FeedbackStatus>(initialStatus);
  // 更新が失敗したときの戻り先。initialStatus は再描画されるまで古いままなので、
  // 直近で永続化に成功した値を保持する。
  const committedStatus = useRef<FeedbackStatus>(initialStatus);

  useEffect(() => {
    // 更新処理の途中で届いた refresh の initialStatus は古いサーバー値のことがある。
    // 永続化済みの値と一致する間は同期せず、直近の選択を守る。サーバーが本当に
    // 変わったとき (別タブでの更新など) だけ同期する。
    if (initialStatus === committedStatus.current) return;
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
      // 失敗はステータス永続化の後 (監査ログ書き込みなど) でも起こりうる。
      // 直前の値へ戻すだけでは DB と食い違うため、サーバーの値を取り直す。
      router.refresh();
    },
    [toast, t, router],
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

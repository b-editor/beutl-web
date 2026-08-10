"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { updateStatus } from "./actions";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import type { FeedbackStatus } from "@beutl/db";
import type { ActionResult } from "@beutl/core";

// クライアントコンポーネントなので @beutl/db の値 (Prisma Client) は import しない。
// satisfies により、enum からメンバーが削除・改名された場合はここで型エラーになる。
const statuses = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
] as const satisfies readonly FeedbackStatus[];

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
  // 更新が失敗したときの戻り先。initialStatus は再描画されるまで古いままなので、
  // 直近で永続化に成功した値を保持する。
  const committedStatus = useRef<FeedbackStatus>(initialStatus);

  useEffect(() => {
    committedStatus.current = initialStatus;
    setSelectedStatus(initialStatus);
  }, [initialStatus]);

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
      try {
        const res = await updateStatus({
          id: feedbackId,
          status: nextStatus,
        });
        if (res.success) {
          committedStatus.current = nextStatus;
        } else {
          setSelectedStatus(committedStatus.current);
        }
        setLastResult(res);
      } catch (e) {
        setSelectedStatus(committedStatus.current);
        setLastResult({
          success: false,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }, [feedbackId, startTransition]);

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

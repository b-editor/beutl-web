"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Button } from "@beutl/ui/ui/button";
import { Textarea } from "@beutl/ui/ui/textarea";
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
import { setPackagePublished, setReleasePublished } from "./actions";

const MIN_REASON_LENGTH = 5;

// パッケージとリリースの公開状態を、理由を添えて切り替える。
export function PublishToggleButton({
  lang,
  target,
  id,
  published,
}: {
  lang: string;
  target: "package" | "release";
  id: string;
  published: boolean;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const next = !published;
  const prefix = `admin:packages.${target}`;
  const label = t(next ? `${prefix}.publish` : `${prefix}.unpublish`);
  const reasonReady = reason.trim().length >= MIN_REASON_LENGTH;

  const submit = () => {
    startTransition(async () => {
      try {
        const input = { published: next, reason };
        const result = target === "package"
          ? await setPackagePublished({ ...input, packageId: id })
          : await setReleasePublished({ ...input, releaseId: id });
        toast({
          title: result.success ? t("admin:packages.updateSuccess") : t("admin:packages.updateFailed"),
          description: result.success ? undefined : result.message,
          variant: result.success ? undefined : "destructive",
        });
        if (result.success) {
          setOpen(false);
          setReason("");
        }
      } catch (error) {
        toast({
          title: t("admin:packages.updateFailed"),
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
      router.refresh();
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={next ? "outline" : "destructive"} disabled={pending}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(next ? `${prefix}.publishConfirmTitle` : `${prefix}.unpublishConfirmTitle`)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(next ? `${prefix}.publishConfirmDescription` : `${prefix}.unpublishConfirmDescription`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("admin:packages.reasonPlaceholder", { count: MIN_REASON_LENGTH })}
          aria-label={t("admin:packages.reason")}
          maxLength={500}
          className="min-h-20"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t("admin:common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !reasonReady}
            onClick={(event) => {
              // 失敗時にダイアログと入力した理由を残すため、既定の「閉じる」を止めて結果で閉じる。
              event.preventDefault();
              submit();
            }}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

"use client";

import { useCallback, useTransition } from "react";
import { deleteUser, revokeUserSessions } from "./actions";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useRouter } from "next/navigation";
import { Button } from "@beutl/ui/ui/button";
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
import { LogOut, Trash2 } from "lucide-react";
import { useToast } from "@beutl/ui/use-toast";

export function DeleteUserButton({ lang, userId }: { lang: string; userId: string }) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const notifyFailure = useCallback(
    (message?: string) => {
      toast({
        title: t("admin:users.deleteFailed"),
        description: message,
        variant: "destructive",
      });
      // 失敗は削除の後 (監査ログ書き込みなど) でも起こりうる。表示中のユーザーが
      // すでに存在しない可能性があるため、サーバーの状態を取り直す。
      router.refresh();
    },
    [toast, t, router],
  );

  const handleDelete = useCallback(() => {
    startTransition(async () => {
      try {
        const res = await deleteUser({ userId });
        if (res.success) {
          toast({ title: t("admin:users.deleteSuccess") });
          router.push(`/${lang}/admin/users`);
          router.refresh();
        } else {
          notifyFailure(res.message);
        }
      } catch (e) {
        notifyFailure(e instanceof Error ? e.message : String(e));
      }
    });
  }, [userId, startTransition, router, toast, t, lang, notifyFailure]);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Trash2 className="mr-2 h-4 w-4" />
          {t("admin:users.delete")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:users.deleteConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:users.deleteConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("admin:common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={handleDelete}
          >
            {t("admin:users.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RevokeSessionsButton({
  lang,
  userId,
  disabled,
}: {
  lang: string;
  userId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const handleRevoke = useCallback(() => {
    startTransition(async () => {
      try {
        const res = await revokeUserSessions({ userId });
        toast({
          title: res.success
            ? t("admin:users.security.revokeSuccess")
            : t("admin:users.security.revokeFailed"),
          description: res.success ? undefined : res.message,
          variant: res.success ? undefined : "destructive",
        });
      } catch (e) {
        toast({
          title: t("admin:users.security.revokeFailed"),
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      }
      router.refresh();
    });
  }, [userId, startTransition, router, toast, t]);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || isPending}>
          <LogOut className="mr-2 h-4 w-4" />
          {t("admin:users.security.revoke")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:users.security.revokeConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:users.security.revokeConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("admin:common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={isPending} onClick={handleRevoke}>
            {t("admin:users.security.revoke")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

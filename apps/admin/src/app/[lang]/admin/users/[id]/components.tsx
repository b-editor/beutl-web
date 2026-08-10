"use client";

import { useCallback, useTransition } from "react";
import { deleteUser } from "./actions";
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
import { Trash2 } from "lucide-react";
import { useToast } from "@beutl/ui/use-toast";

export function DeleteUserButton({ lang, userId }: { lang: string; userId: string }) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const handleDelete = useCallback(() => {
    startTransition(async () => {
      const res = await deleteUser({ userId });
      if (res.success) {
        toast({ title: t("admin:users.deleteSuccess") });
        router.push(`/${lang}/admin/users`);
        router.refresh();
      } else {
        toast({
          title: t("admin:users.deleteFailed"),
          description: res.message,
          variant: "destructive",
        });
      }
    });
  }, [userId, startTransition, router, toast, t, lang]);

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

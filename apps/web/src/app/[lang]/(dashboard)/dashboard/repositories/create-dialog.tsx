"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@beutl/ui/ui/dialog";
import { ErrorDisplay } from "@beutl/ui/error-display";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import SubmitButton from "@beutl/ui/submit-button";
import { Plus } from "lucide-react";
import { createRepositoryAction } from "./actions";

export function CreateRepositoryDialog({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useActionState(createRepositoryAction, {
    success: false,
  });

  // 作成に成功したらダイアログを畳む。一覧は server action 側で再検証済み。
  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state.success]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          {t("repositories:create")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form action={dispatch} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("repositories:createTitle")}</DialogTitle>
            <DialogDescription>
              {t("repositories:createDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="name">{t("repositories:name")}</Label>
            <Input id="name" name="name" autoComplete="off" required />
            <p className="text-xs text-muted-foreground">
              {t("repositories:nameHint")}
            </p>
            {!state.success && state.errors?.name && (
              <ErrorDisplay errors={state.errors.name} />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="description">
              {t("repositories:descriptionOptional")}
            </Label>
            <Textarea id="description" name="description" rows={3} />
          </div>

          {!state.success && state.message && (
            <p className="text-sm font-medium text-destructive">
              {state.message}
            </p>
          )}

          <DialogFooter>
            <SubmitButton>{t("repositories:create")}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

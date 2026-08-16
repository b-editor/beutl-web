"use client";

import { useActionState } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@beutl/ui/ui/card";
import { ErrorDisplay } from "@beutl/ui/error-display";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import SubmitButton from "@beutl/ui/submit-button";
import {
  deleteRepositoryAction,
  renameRepositoryAction,
  updateDescriptionAction,
} from "../../../actions";

export function SettingsForms({
  lang,
  owner,
  repo,
  description,
}: {
  lang: string;
  owner: string;
  repo: string;
  description: string;
}) {
  const { t } = useTranslation(lang);
  const [renameState, rename] = useActionState(renameRepositoryAction, {
    success: false,
  });
  const [descriptionState, saveDescription] = useActionState(
    updateDescriptionAction,
    { success: false },
  );
  const [deleteState, remove] = useActionState(deleteRepositoryAction, {
    success: false,
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("repositories:repositoryDescription")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveDescription} className="flex flex-col gap-3">
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="name" value={repo} />
            <Textarea
              name="description"
              rows={3}
              defaultValue={description}
              aria-label={t("repositories:repositoryDescription")}
            />
            {descriptionState.success && descriptionState.message && (
              <p className="text-sm text-muted-foreground">
                {descriptionState.message}
              </p>
            )}
            {!descriptionState.success && descriptionState.message && (
              <p className="text-sm font-medium text-destructive">
                {descriptionState.message}
              </p>
            )}
            <div>
              <SubmitButton>{t("repositories:saveDescription")}</SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("repositories:rename")}</CardTitle>
          <CardDescription>
            {t("repositories:renameDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={rename} className="flex flex-col gap-3">
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="name" value={repo} />
            <Label htmlFor="newName">{t("repositories:newName")}</Label>
            <Input
              id="newName"
              name="newName"
              defaultValue={repo}
              autoComplete="off"
              className="max-w-sm"
            />
            {!renameState.success && renameState.errors?.newName && (
              <ErrorDisplay errors={renameState.errors.newName} />
            )}
            {!renameState.success && renameState.message && (
              <p className="text-sm font-medium text-destructive">
                {renameState.message}
              </p>
            )}
            <div>
              <SubmitButton>{t("repositories:rename")}</SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-base text-destructive">
            {t("repositories:deleteRepository")}
          </CardTitle>
          <CardDescription>
            {t("repositories:deleteDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 削除は Forgejo 側で即時かつ不可逆。リポジトリ名の入力を必須にする。 */}
          <form action={remove} className="flex flex-col gap-3">
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="name" value={repo} />
            <Label htmlFor="confirmation">
              {t("repositories:deleteConfirm", { name: repo })}
            </Label>
            <Input
              id="confirmation"
              name="confirmation"
              autoComplete="off"
              className="max-w-sm"
            />
            {!deleteState.success && deleteState.errors?.confirmation && (
              <ErrorDisplay errors={deleteState.errors.confirmation} />
            )}
            {!deleteState.success && deleteState.message && (
              <p className="text-sm font-medium text-destructive">
                {deleteState.message}
              </p>
            )}
            <div>
              <SubmitButton variant="destructive">
                {t("repositories:delete")}
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

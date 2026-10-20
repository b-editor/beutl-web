"use client";

import { Edit, Loader2, MoreVertical, Save, Upload } from "lucide-react";
import { Button } from "@beutl/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@beutl/ui/ui/dropdown-menu";
import { useCallback, useState, useTransition } from "react";
import {
  cn,
  localizedDisplayName,
  localizedShortDescription,
  pickTranslation,
} from "@beutl/core";
import { Input } from "@beutl/ui/ui/input";
import type { State } from "./actions/_shared";
import {
  updateDisplayNameAndShortDescription,
  deletePackage,
  changePackageVisibility,
  uploadIcon,
} from "./actions/package";
import { ErrorDisplay } from "@beutl/ui/error-display";
import { showOpenFileDialog } from "@/lib/fileDialog";
import { useToast } from "@beutl/ui/use-toast";
import type { Package } from "./types";
import { useTranslation } from "@beutl/ui/i18n-client";
import type { LanguageLabel } from "@/lib/language-labels";
import { useTranslationMode } from "./translation-mode";
import {
  TranslationLanguageDialog,
  TranslationLanguageMenu,
} from "./translation-language-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@beutl/ui/ui/alert-dialog";

type TranslationDraft = { displayName: string; shortDescription: string };

function initialTranslations(
  pkg: Package,
  languages: LanguageLabel[],
): Record<string, TranslationDraft> {
  const saved = new Map(
    pkg.PackageTranslation.map((translation) => [
      translation.lang,
      {
        displayName: translation.displayName ?? "",
        shortDescription: translation.shortDescription ?? "",
      },
    ]),
  );
  return Object.fromEntries(
    languages.map((language) => [
      language.code,
      saved.get(language.code) ?? { displayName: "", shortDescription: "" },
    ]),
  );
}

function updateTranslation(
  translations: Record<string, TranslationDraft>,
  code: string,
  patch: Partial<TranslationDraft>,
): Record<string, TranslationDraft> {
  return {
    ...translations,
    [code]: {
      displayName: translations[code]?.displayName ?? "",
      shortDescription: translations[code]?.shortDescription ?? "",
      ...patch,
    },
  };
}

export function PackageInfoForm({
  pkg,
  lang,
  languages,
}: { pkg: Package; lang: string; languages: LanguageLabel[] }) {
  const [edit, setEdit] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [languageDialog, setLanguageDialog] = useState(false);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState(pkg.displayName || "");
  const [shortDescription, setShortDescription] = useState(
    pkg.shortDescription,
  );
  const [translations, setTranslations] = useState<
    Record<string, TranslationDraft>
  >(() => initialTranslations(pkg, languages));
  const [state, setState] = useState<State>({});
  const [pendingActions, startDropdownActions] = useTransition();
  const [pendingIcon, startUploadIcon] = useTransition();
  const { toast } = useToast();
  const { t } = useTranslation(lang);
  const { language: selectedLanguage } = useTranslationMode();
  const translationLanguage = languages.find(
    (language) => language.code === selectedLanguage,
  );
  const editLanguage =
    pkg.audience === "USER" ? translationLanguage : undefined;
  const activeTranslation = pickTranslation(
    pkg.PackageTranslation,
    selectedLanguage ?? "",
  );
  // 選択言語の翻訳が空で原文へフォールバックしている間は、原文を薄い色で
  // 表示して翻訳未入力であることを分かるようにする。
  const displayNameIsFallback =
    Boolean(selectedLanguage) && !activeTranslation?.displayName?.trim();
  const shortDescriptionIsFallback =
    Boolean(selectedLanguage) && !activeTranslation?.shortDescription?.trim();

  const handleSubmit = useCallback(async () => {
    try {
      setPending(true);
      const data = new FormData();
      data.append("displayName", displayName || "");
      data.append("shortDescription", shortDescription);
      data.append("id", pkg.id);
      // この欄は短い説明だけを持つ。説明 (description) を送らないのは、
      // 保存側が「送っていないフィールドには触らない」ため。
      data.append(
        "translations",
        JSON.stringify(
          languages.map((language) => ({
            lang: language.code,
            displayName: translations[language.code]?.displayName ?? "",
            shortDescription:
              translations[language.code]?.shortDescription ?? "",
          })),
        ),
      );
      const newState = await updateDisplayNameAndShortDescription(state, data);
      setState(newState);

      setEdit(!newState.success);
    } finally {
      setPending(false);
    }
  }, [displayName, shortDescription, translations, languages, pkg.id, state]);

  const handleCancel = useCallback(() => {
    setDisplayName(pkg.displayName || "");
    setShortDescription(pkg.shortDescription);
    setTranslations(initialTranslations(pkg, languages));
    setState({});
    setEdit(false);
  }, [pkg, languages]);

  const handleDelete = useCallback(async () => {
    startDropdownActions(async () => {
      const res = await deletePackage(pkg.id);
      if (!res.success) {
        toast({
          title: t("developer:common.error"),
          description: res.message,
          variant: "destructive",
        });
      }
    });
  }, [pkg.id, t, toast]);

  const handleChangeVisibility = useCallback(async () => {
    startDropdownActions(async () => {
      const res = await changePackageVisibility(pkg.id, !pkg.published);
      if (!res.success) {
        toast({
          title: t("developer:common.error"),
          description: res.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: t("developer:common.success"),
          description: t("developer:packageInfo.changed"),
        });
      }
    });
  }, [pkg.id, pkg.published, t, toast]);

  const handleUploadIconClick = useCallback(async () => {
    const files = await showOpenFileDialog({ accept: "image/*" });

    const file = files?.[0];
    if (!file) {
      return;
    }
    startUploadIcon(async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("id", pkg.id);
      const res = await uploadIcon(formData);
      if (!res.success) {
        toast({
          title: t("developer:common.error"),
          description: res.message,
          variant: "destructive",
        });
      }
    });
  }, [toast, pkg.id, t]);

  return (
    <>
      <div className="sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4">
          <div className="flex gap-4 w-full">
            <Button
              className="group p-0 w-16 h-16 bg-secondary hover:bg-secondary/90 relative"
              variant="ghost"
              onClick={handleUploadIconClick}
            >
              {pkg.iconFileUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  className="w-16 h-16 max-w-fit rounded-md group-hover:opacity-80"
                  alt="Package icon"
                  src={pkg.iconFileUrl}
                />
              )}
              {pendingIcon ? (
                <Loader2 className="w-6 h-6 animate-spin absolute" />
              ) : (
                <Upload className="w-6 h-6 group-hover:visible invisible absolute" />
              )}
            </Button>

            <div className="flex-1 min-w-0">
              <h2
                className={cn(
                  "font-bold text-2xl break-words",
                  displayNameIsFallback && "text-muted-foreground",
                  edit && "hidden",
                )}
              >
                {localizedDisplayName(pkg, selectedLanguage ?? "") || pkg.name}
              </h2>
              {pkg.audience === "USER" && <Input
                className={cn(!edit && "hidden")}
                value={
                  editLanguage
                    ? translations[editLanguage.code]?.displayName ?? ""
                    : displayName
                }
                type="text"
                placeholder={
                  editLanguage
                    ? pkg.displayName || pkg.name
                    : t("developer:forms.displayNamePlaceholder")
                }
                onChange={(e) => {
                  if (editLanguage) {
                    setTranslations((current) =>
                      updateTranslation(current, editLanguage.code, {
                        displayName: e.target.value,
                      })
                    );
                  } else {
                    setDisplayName(e.target.value);
                  }
                }}
              />}
              {state?.errors?.displayName && !editLanguage && (
                <ErrorDisplay errors={state.errors.displayName} />
              )}
              <p className="text-muted-foreground text-sm font-medium break-all">
                {pkg.name}
              </p>
            </div>
          </div>

          {!edit && (
            <div className="flex gap-2">
              {pkg.audience === "USER" && <Button variant="ghost" size="icon" aria-label={t("developer:common.edit")} onClick={() => setEdit(true)}>
                <Edit className="w-4 h-4" />
              </Button>}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" disabled={pendingActions}>
                    {pendingActions ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <MoreVertical className="w-4 h-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>
                    {t("developer:common.actions")}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setDeleteDialog(true)}>
                    {t("developer:common.delete")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleChangeVisibility}>
                    {pkg.published
                      ? t("developer:packageInfo.unpublish")
                      : t("developer:common.publish")}
                  </DropdownMenuItem>
                  {pkg.audience === "USER" && (
                    <TranslationLanguageMenu
                      lang={lang}
                      onAddLanguage={() => setLanguageDialog(true)}
                    />
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>
      <p
        className={cn(
          "mt-4",
          shortDescriptionIsFallback
            ? "text-muted-foreground"
            : "text-foreground/70",
          edit && "hidden",
        )}
      >
        {localizedShortDescription(pkg, selectedLanguage ?? "")}
      </p>
      {pkg.audience === "USER" && (
        <Input
          className={cn("mt-4", !edit && "hidden")}
          value={
            editLanguage
              ? translations[editLanguage.code]?.shortDescription ?? ""
              : shortDescription
          }
          placeholder={editLanguage ? shortDescription : undefined}
          onChange={(e) => {
            if (editLanguage) {
              setTranslations((current) =>
                updateTranslation(current, editLanguage.code, {
                  shortDescription: e.target.value,
                })
              );
            } else {
              setShortDescription(e.target.value);
            }
          }}
        />
      )}
      {state?.errors?.shortDescription && !editLanguage && (
        <ErrorDisplay errors={state.errors.shortDescription} />
      )}
      {state?.errors?.translations && editLanguage && (
        <ErrorDisplay errors={state.errors.translations} />
      )}

      <div className="flex gap-2 justify-end mt-4">
        <Button
          variant="default"
          size="default"
          className={cn(!edit && "hidden")}
          disabled={pending}
          onClick={handleSubmit}
        >
          {pending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {t("developer:common.save")}
        </Button>
        <Button
          variant="outline"
          size="default"
          className={cn(!edit && "hidden")}
          disabled={pending}
          onClick={handleCancel}
        >
          {t("developer:common.cancel")}
        </Button>
      </div>

      {pkg.audience === "USER" && (
        <TranslationLanguageDialog
          lang={lang}
          open={languageDialog}
          onOpenChange={setLanguageDialog}
        />
      )}

      <AlertDialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("developer:common.confirmDeleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("developer:packageInfo.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("developer:common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("developer:common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

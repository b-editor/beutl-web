"use client";

import { Check, Languages, Plus } from "lucide-react";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@beutl/ui/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@beutl/ui/ui/dropdown-menu";
import { useTranslation } from "@beutl/ui/i18n-client";
import { cn } from "@beutl/core";
import { useTranslationMode } from "./translation-mode";

/** 「...」メニュー内の表示言語サブメニュー。 */
export function TranslationLanguageMenu({
  lang,
  onAddLanguage,
}: {
  lang: string;
  onAddLanguage: () => void;
}) {
  const { language, addedLanguages, setLanguage } = useTranslationMode();
  const { t } = useTranslation(lang);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages className="w-4 h-4 mr-2" />
        {t("developer:translation.languageMenu")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {addedLanguages.length > 0 && (
          <>
            <DropdownMenuItem onSelect={() => setLanguage(null)}>
              <Check
                className={cn(
                  "w-4 h-4 mr-2",
                  language === null ? "opacity-100" : "opacity-0",
                )}
              />
              {t("developer:translation.original")}
            </DropdownMenuItem>
            {addedLanguages.map((added) => (
              <DropdownMenuItem
                key={added.code}
                onSelect={() => setLanguage(added.code)}
              >
                <Check
                  className={cn(
                    "w-4 h-4 mr-2",
                    language === added.code ? "opacity-100" : "opacity-0",
                  )}
                />
                {added.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={onAddLanguage}>
          <Plus className="w-4 h-4 mr-2" />
          {t("developer:translation.addLanguage")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** 表示言語として追加できる言語を選ぶダイアログ。 */
export function TranslationLanguageDialog({
  lang,
  open,
  onOpenChange,
}: {
  lang: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { availableLanguages, addLanguage, setLanguage } = useTranslationMode();
  const { t } = useTranslation(lang);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("developer:translation.addLanguage")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1 py-2">
          {availableLanguages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("developer:translation.noLanguagesToAdd")}
            </p>
          ) : (
            availableLanguages.map((available) => (
              <Button
                key={available.code}
                variant="ghost"
                className="justify-start"
                onClick={() => {
                  addLanguage(available.code);
                  setLanguage(available.code);
                  onOpenChange(false);
                }}
              >
                {available.name}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

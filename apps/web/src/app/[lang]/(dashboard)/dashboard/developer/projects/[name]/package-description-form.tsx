"use client";

import { Button } from "@beutl/ui/ui/button";
import type { Package } from "./types";
import { Edit, Loader2, Save } from "lucide-react";
import { useCallback, useReducer, useState, useTransition } from "react";
import { Markdown } from "@beutl/ui/ui/markdown";
import { MarkdownEditor } from "@beutl/ui/ui/markdown-editor";
import { useToast } from "@beutl/ui/use-toast";
import { updateDescription } from "./actions/package";
import { useTranslation } from "@beutl/ui/i18n-client";

export function PackageDescriptionForm({
  pkg,
  lang,
}: { pkg: Package; lang: string }) {
  const [edit, toggleEdit] = useReducer((edit) => !edit, false);
  const [pending, startTransition] = useTransition();
  const [description, setDescription] = useState(pkg.description);
  const { toast } = useToast();
  const { t } = useTranslation(lang);

  const handleSave = useCallback(async () => {
    startTransition(async () => {
      const res = await updateDescription({ packageId: pkg.id, description });
      if (!res.success) {
        toast({
          title: t("developer:common.error"),
          description: res.message,
          variant: "destructive",
        });
      } else {
        toggleEdit();
      }
    });
  }, [description, pkg.id, t, toast]);

  return (
    <div>
      <div className="flex justify-between items-center mt-6 border-b pb-2">
        <h3 className="font-bold text-xl">
          {t("developer:description.title")}
        </h3>
        {!edit && (
          <Button
            size="icon"
            variant="ghost"
            className="w-8 h-8"
            aria-label={t("developer:common.edit")}
            onClick={toggleEdit}
          >
            <Edit className="w-4 h-4" />
          </Button>
        )}
      </div>
      {!edit && (
        <Markdown className="mt-4">
          {pkg.description}
        </Markdown>
      )}
      {edit && (
        <>
          <MarkdownEditor
            id="package-description"
            aria-label={t("developer:description.title")}
            maxLength={1000}
            className="mt-4 mb-2"
            value={description}
            disabled={pending}
            onChange={(e) => setDescription(e.target.value)}
            labels={{
              write: t("developer:markdown.write"),
              preview: t("developer:markdown.preview"),
              hint: t("developer:markdown.hint"),
              emptyPreview: t("developer:markdown.emptyPreview"),
            }}
          />
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={pending}>
              {pending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {t("developer:common.save")}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                toggleEdit();
                setDescription(pkg.description);
              }}
            >
              {t("developer:common.cancel")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

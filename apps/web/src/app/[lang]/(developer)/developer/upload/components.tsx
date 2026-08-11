"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Separator } from "@beutl/ui/ui/separator";
import { Textarea } from "@beutl/ui/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import SubmitButton from "@beutl/ui/submit-button";
import { useTranslation } from "@beutl/ui/i18n-client";
import { publishDataPackage } from "./actions";

export function Form({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const [type, setType] = useState("material");
  const [fileCount, setFileCount] = useState(0);
  const [error, setError] = useState<string>();
  const [isPending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Folder selection keeps each file's relative path, which the server uses to
    // lay the payload out under materials/ or templates/.
    fileInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    const formData = new FormData(e.currentTarget);
    formData.delete("files");
    const files = fileInput.current?.files;
    if (files) {
      for (const file of files) {
        formData.append("file", file, file.webkitRelativePath || file.name);
      }
    }
    startTransition(async () => {
      const res = await publishDataPackage(formData);
      if (!res.success) {
        setError(res.message);
      }
    });
  };

  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <form onSubmit={handleSubmit}>
        <h2 className="font-bold text-2xl">
          {t("developer:upload.title")}
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          {t("developer:upload.description")}
        </p>

        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="type">
            {t("developer:upload.type")}
          </Label>
          <Separator />
          <div className="mx-6 mt-4">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="md:max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="material">
                  {t("developer:details.packageTypeMaterial")}
                </SelectItem>
                <SelectItem value="template">
                  {t("developer:details.packageTypeTemplate")}
                </SelectItem>
                <SelectItem value="both">
                  {t("developer:details.packageTypeBoth")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("developer:upload.typeDescription")}
          </p>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="slug">
            {t("developer:upload.slug")}
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="text"
            id="slug"
            name="slug"
            autoComplete="off"
            placeholder="city-photos"
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("developer:upload.slugDescription", {
              prefix:
                type === "material"
                  ? "Beutl.Materials"
                  : type === "template"
                    ? "Beutl.Templates"
                    : "Beutl.Data",
            })}
          </p>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="title">
            {t("developer:upload.titleLabel")}
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="text"
            id="title"
            name="title"
            autoComplete="off"
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("developer:upload.titleDescription")}
          </p>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="description">
            {t("developer:upload.descriptionLabel")}
          </Label>
          <Separator />
          <Textarea
            className="max-w-lg w-auto mt-4 mx-6"
            id="description"
            name="description"
            rows={4}
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("developer:upload.descriptionHint")}
          </p>
        </div>

        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="files">
            {t("developer:upload.files")}
          </Label>
          <Separator />
          <input
            ref={fileInput}
            className="mx-6 mt-4"
            type="file"
            id="files"
            name="files"
            multiple
            onChange={(e) => setFileCount(e.target.files?.length ?? 0)}
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("developer:upload.filesDescription")}
          </p>
          {fileCount > 0 && (
            <p className="text-sm font-medium mx-6 mb-6 -mt-2">
              {t("developer:upload.filesSelected", { count: fileCount })}
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm font-medium text-destructive mt-6">
            {error}
          </p>
        )}

        <SubmitButton className="mt-6" forceSpinner={isPending} disabled={isPending}>
          {t("developer:upload.publish")}
        </SubmitButton>
      </form>
    </div>
  );
}

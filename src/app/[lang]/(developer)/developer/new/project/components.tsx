"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { createNewProject } from "./actions";
import { useActionState } from "react";
import { ErrorDisplay } from "@/components/error-display";
import SubmitButton from "@/components/submit-button";
import { useTranslation } from "@/app/i18n/client";

export function Form({ lang }: { lang: string }) {
  const [state, dispatch] = useActionState(createNewProject, {});
  const { t } = useTranslation(lang);

  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <form action={dispatch}>
        <h2 className="font-bold text-2xl">
          {t("developer:newProject.title")}
        </h2>
        <div className="rounded-lg border text-card-foreground flex flex-col mt-4">
          <Label className="font-bold text-md m-6 mb-4" htmlFor="packageId">
            {t("developer:newProject.packageId")}
          </Label>
          <Separator />
          <Input
            className="max-w-sm w-auto mt-4 mx-6"
            type="text"
            id="packageId"
            name="packageId"
            autoComplete="off"
            placeholder="Company.Product"
          />
          <p className="text-sm text-muted-foreground m-6 mt-2">
            {t("developer:newProject.packageIdDescription")}
          </p>
          {state.errors?.packageId && (
            <ErrorDisplay
              className="mx-6 mb-6 -mt-2"
              errors={state.errors.packageId}
            />
          )}
        </div>
        <div className="rounded-lg border text-card-foreground mt-4 p-6">
          {state.message && (
            <p className="text-sm font-medium text-destructive mb-6">
              {state.message}
            </p>
          )}
          <div className="flex gap-2">
            <SubmitButton>{t("developer:common.create")}</SubmitButton>
            {/* <Button variant="outline">
              <Upload className="w-4 h-4 mr-2" />
              Create from package file
            </Button> */}
          </div>
        </div>
      </form>
    </div>
  );
}

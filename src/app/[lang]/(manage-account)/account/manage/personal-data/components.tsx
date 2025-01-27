"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState, type ComponentProps } from "react";
import { useFormState } from "react-dom";
import { submit } from "./actions";
import SubmitButton from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTranslation } from "@/app/i18n/client";

export function Form({
  email,
  cancelable,
  lang,
  ...props
}: ComponentProps<"form"> & {
  email: string;
  cancelable?: boolean;
  lang: string;
}) {
  const [state, dispatch] = useFormState(submit, {});
  const [spinnerType, setSpinnerType] = useState<0 | 1>(0);
  const { t } = useTranslation(lang);

  return (
    <form {...props} action={dispatch}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="email">{t("account:email.email")}</Label>
          <Input type="email" id="email" defaultValue={email} readOnly />
        </div>
        <p>
          {t("account:email.clickOnTheLink")}
          <br />
          {t("account:data.deleteAccount")}
        </p>

        {state.message && (
          <Alert
            variant={state.success ? "default" : "destructive"}
            className="my-4"
          >
            <AlertTitle>{state.success ? t("success") : t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex gap-4 my-6">
          <SubmitButton
            variant="destructive"
            showSpinner={spinnerType === 0}
            onClick={() => setSpinnerType(0)}
          >
            {t("account:data.deleteAccount")}
          </SubmitButton>
          {cancelable && (
            <SubmitButton
              variant="outline"
              name="cancel"
              value="true"
              showSpinner={spinnerType === 1}
              onClick={() => setSpinnerType(1)}
            >
              {t("cancel")}
            </SubmitButton>
          )}
        </div>
      </div>
    </form>
  );
}

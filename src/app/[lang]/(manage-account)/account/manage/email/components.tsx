"use client"

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ComponentProps } from "react";
import { useFormState } from "react-dom";
import { sendConfirmationEmail } from "./actions";
import SubmitButton from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTranslation } from "@/app/i18n/client";

export function Form({ email, emailUpdated, lang, ...props }: ComponentProps<"form"> & { email: string, emailUpdated?: boolean,lang:string }) {
  const [state, dispatch] = useFormState(sendConfirmationEmail, {})
  const { t } = useTranslation(lang);

  return (
    <form {...props} action={dispatch}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="currentEmail">{t("account:email.currentEmail")}</Label>
          <Input type="email" id="currentEmail" defaultValue={email} readOnly />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="newEmail">{t("account:email.newEmail")}</Label>
          <Input type="email" id="newEmail" name="newEmail" />
        </div>

        {state.message && (
          <Alert variant={state.success ? "default" : "destructive"} className="my-4">
            <AlertTitle>{state.success ? t("success") : t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {emailUpdated && (
          <Alert  className="my-4">
            <AlertTitle>{t("success")}</AlertTitle>
            <AlertDescription>{t("account:email.emailUpdated")}</AlertDescription>
          </Alert>
        )}

        <SubmitButton className="my-6 self-start">{t("save")}</SubmitButton>
      </div>
    </form>
  )
}
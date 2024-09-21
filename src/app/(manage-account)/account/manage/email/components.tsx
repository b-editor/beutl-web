"use client"

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ComponentProps } from "react";
import { useFormState } from "react-dom";
import { sendConfirmationEmail } from "./actions";
import SubmitButton from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function Form({ email, emailUpdated, ...props }: ComponentProps<"form"> & { email: string, emailUpdated?: boolean }) {
  const [state, dispatch] = useFormState(sendConfirmationEmail, {})

  return (
    <form {...props} action={dispatch}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="currentEmail">現在のメールアドレス</Label>
          <Input type="email" id="currentEmail" defaultValue={email} readOnly />
        </div>
        <div className="flex flex-col space-y-1.5 max-w-xs">
          <Label htmlFor="newEmail">新しいメールアドレス</Label>
          <Input type="email" id="newEmail" name="newEmail" />
        </div>

        {state.message && (
          <Alert variant={state.success ? "default" : "destructive"} className="my-4">
            <AlertTitle>{state.success ? "成功" : "エラー"}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        {emailUpdated && (
          <Alert  className="my-4">
            <AlertTitle>成功</AlertTitle>
            <AlertDescription>メードアドレスは変更されました</AlertDescription>
          </Alert>
        )}

        <SubmitButton className="my-6 self-start">変更</SubmitButton>
      </div>
    </form>
  )
}
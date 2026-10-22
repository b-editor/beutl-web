"use client";

import { useActionState, useEffect } from "react";
import SubmitButton from "@beutl/ui/submit-button";
import { issueNativeAuthCodeAction, type NativeAuthIssueState } from "./actions";

export function NativeAuthConsentForm({ identifier, userId, submitLabel, failureText }: {
  identifier: string;
  userId: string;
  submitLabel: string;
  failureText: string;
}) {
  const [state, dispatch, isPending] = useActionState<NativeAuthIssueState, FormData>(
    issueNativeAuthCodeAction,
    { status: "idle" },
  );

  useEffect(() => {
    if (state.status === "ok") location.href = state.callbackUrl;
  }, [state]);

  return (
    <form action={dispatch}>
      <input type="hidden" name="identifier" value={identifier} />
      <input type="hidden" name="userId" value={userId} />
      {state.status === "failed" && (
        <p className="text-sm font-medium text-destructive" role="alert">{failureText}</p>
      )}
      <SubmitButton
        className="w-full"
        forceSpinner={isPending}
        disabled={isPending || state.status === "ok"}
      >
        {submitLabel}
      </SubmitButton>
    </form>
  );
}

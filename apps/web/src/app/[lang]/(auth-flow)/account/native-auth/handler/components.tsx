"use client";

import { useEffect } from "react";
import { useActionState } from "react";
import SubmitButton from "@beutl/ui/submit-button";
import { issueNativeAuthCodeAction, type NativeAuthIssueState } from "./actions";

// 同意ボタン。発行に成功した result の callbackUrl (コード付き) へ
// location.href する。サーバー側で遷移先の検証を済ませてある。
export function NativeAuthConsentForm({
  identifier,
  submitLabel,
  failureText,
}: {
  identifier: string;
  submitLabel: string;
  failureText: string;
}) {
  const [state, dispatch, isPending] = useActionState<
    NativeAuthIssueState,
    FormData
  >(issueNativeAuthCodeAction, { status: "idle" });

  useEffect(() => {
    if (state.status === "ok") location.href = state.callbackUrl;
  }, [state]);

  return (
    <form action={dispatch}>
      <input type="hidden" name="identifier" value={identifier} />
      {state.status === "failed" && (
        <p className="text-sm font-medium text-destructive" role="alert">
          {failureText}
        </p>
      )}
      {/* ok のあとは遷移中。誤って再発行しないよう送信を止める。 */}
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

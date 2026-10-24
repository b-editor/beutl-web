"use client";

import { startTransition, useActionState } from "react";
import { Button } from "@beutl/ui/ui/button";
import { useTranslation } from "@beutl/ui/i18n-client";
import { authClient } from "@/lib/auth-client";
import { consentToNativeOAuth } from "./oauth-actions";

export function OAuthConsentForm({
  oauthQuery,
  userId,
  hasPasskeys,
  lang,
}: {
  oauthQuery: string;
  userId: string;
  hasPasskeys: boolean;
  lang: string;
}) {
  const { t } = useTranslation(lang);
  const [failed, submit, busy] = useActionState(async (_failed: boolean, accept: boolean) => {
    if (accept && hasPasskeys) {
      try {
        // Reauthenticate without resuming OAuth before the explicit consent action.
        const result = await authClient.signIn.passkey();
        if (result.error || result.data?.user.id !== userId) return true;
      } catch {
        return true;
      }
    }
    // Keep the redirect outside the passkey catch so React can handle it as navigation.
    const result = await consentToNativeOAuth(oauthQuery, userId, accept);
    return !result.success;
  }, false);
  return (
    <div className="space-y-3">
      {failed && !busy && (
        <p role="alert" className="text-sm text-destructive">
          {t("auth:nativeAuth.issueFailed")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => startTransition(() => submit(true))}>
          {t(
            hasPasskeys
              ? "auth:deviceAuthorization.approveWithPasskey"
              : "auth:deviceAuthorization.approve",
          )}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => startTransition(() => submit(false))}>
          {t("auth:deviceAuthorization.deny")}
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@beutl/ui/use-toast";
import { useTranslation } from "@beutl/ui/i18n-client";
import { resolveSafeRedirectPath } from "@beutl/core";

type OAuthProvider = "google" | "github";

export function useOAuthSignIn({
  returnUrl,
  lang,
}: {
  returnUrl?: string;
  lang: string;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  const handleOAuthSignIn = async (provider: OAuthProvider) => {
    setOauthLoading(provider);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL:
          resolveSafeRedirectPath(returnUrl, window.location.origin) ??
          `/${lang}/admin`,
      });
      // signIn.social は失敗しても throw せず error を返すため、明示的に確認する。
      if (result?.error) {
        throw new Error(result.error.message);
      }
    } catch {
      toast({
        title: t("admin:common.error"),
        description: t("auth:errors.oauth"),
        variant: "destructive",
      });
    } finally {
      // 成功時はページ遷移でアンマウントされるが、リダイレクトがブロックされた
      // 場合はここで解除しないとボタンがローディングのまま残る。
      setOauthLoading(null);
    }
  };

  return { oauthLoading, handleOAuthSignIn };
}

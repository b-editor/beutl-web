"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/app/i18n/client";

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
      await authClient.signIn.social({
        provider,
        callbackURL: returnUrl || "/",
      });
    } catch {
      toast({
        title: t("error"),
        description: t("auth:errors.oauth"),
        variant: "destructive",
      });
      setOauthLoading(null);
    }
  };

  return { oauthLoading, handleOAuthSignIn };
}

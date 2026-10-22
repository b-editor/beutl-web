"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { signInWithEmailAction } from "./actions";
import SubmitButton from "@beutl/ui/submit-button";
import { useState, useActionState, useEffect, useRef } from "react";
import { ErrorDisplay } from "@beutl/ui/error-display";
import { useToast } from "@beutl/ui/use-toast";
import { authClient } from "@/lib/auth-client";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useRouter } from "next/navigation";
import { GitHubLogo, GoogleLogo } from "@beutl/ui/logo";
import { AuthLogo } from "@/components/auth/auth-logo";
import { useOAuthSignIn } from "@/components/auth/oauth";
import { resolveSafeRedirectPath } from "@beutl/core";

export default function Form({
  returnUrl,
  provider,
  lang,
  legalLinks,
}: {
  returnUrl?: string;
  provider?: "google" | "github";
  lang: string;
  legalLinks: React.ReactNode;
}) {
  const [state, dispatch] = useActionState(signInWithEmailAction, {});
  const { t } = useTranslation(lang);
  const { oauthLoading, handleOAuthSignIn } = useOAuthSignIn({ returnUrl, lang });
  const [passkeyVerifying, setPasskeyVerifying] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  // デスクトップ (sign-in-with ルート経由) が provider を指定してきた場合
  // は自動でソーシャルサインインを開始する。同一タブの戻る操作でループし
  // ないよう、マウントにつき 1 回、さらに sessionStorage のゲートで 1 回
  // だけ発火させる。ゲートは返り先 (native-auth の試行ごとに identifier が
  // 変わる) を含むため、同じタブでの新しいサインイン試行は別の試行として
  // 自動開始され、戻る操作 (URL が同じ) だけが抑止される。自動開始でき
  // なかった環境ではボタンから手動で開始できる。
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!provider || autoStarted.current) return;
    autoStarted.current = true;
    const gate = `beutl.oauthAutoStart.${provider}.${returnUrl ?? ""}`;
    try {
      if (sessionStorage.getItem(gate)) return;
      sessionStorage.setItem(gate, "1");
    } catch {
      // safari プライベートモード等で sessionStorage が拒否されることがある。
      // ループ防止のゲートが無くなるだけで自動開始は先へ進めてよい。
    }
    void handleOAuthSignIn(provider);
  }, [provider, returnUrl, handleOAuthSignIn]);

  const handlePasskeySignIn = async () => {
    setPasskeyVerifying(true);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        throw new Error(result.error.message);
      }
      router.push(
        resolveSafeRedirectPath(returnUrl, window.location.origin) ??
          `/${lang}/dashboard`,
      );
    } catch (error) {
      console.error("Passkey sign-in failed", error);
      toast({
        title: t("error"),
        description: t("auth:errors.passkey"),
        variant: "destructive",
      });
    } finally {
      setPasskeyVerifying(false);
    }
  };

  return (
    <form action={dispatch}>
      <div className="h-screen flex items-center justify-center">
        <div className="w-[350px] flex flex-col gap-4 relative">
          <AuthLogo />
          <Card>
            <CardHeader>
              <CardTitle>{t("auth:signIn")}</CardTitle>
              <CardDescription>{t("auth:useYourAccount")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid w-full items-center gap-4">
                <div className="flex flex-col space-y-1.5">
                  <Label htmlFor="email">{t("auth:email")}</Label>
                  <Input name="email" id="email" placeholder="me@example.com" />
                  {state.errors?.email && (
                    <ErrorDisplay errors={state.errors.email} />
                  )}
                </div>
                {state?.message && (
                  <p className="text-sm font-medium text-destructive">
                    {state?.message}
                  </p>
                )}
              </div>
              <input type="hidden" name="returnUrl" value={returnUrl ?? ""} />
            </CardContent>
            <CardFooter className="block">
              <SubmitButton
                forceSpinner={passkeyVerifying}
                disabled={passkeyVerifying || oauthLoading !== null}
                className="w-full"
              >
                {t("auth:signIn")}
              </SubmitButton>
              <Link
                href={`/${lang}/account/sign-up`}
                className="text-sm font-medium inline-block mt-6"
              >
                {t("auth:createAccount")}
              </Link>
            </CardFooter>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex gap-4">
                <div className="flex-1">
                  <SubmitButton
                    variant="outline"
                    className="p-2 w-full"
                    type="button"
                    showSpinner={false}
                    forceSpinner={oauthLoading === "google"}
                    disabled={passkeyVerifying || oauthLoading !== null}
                    onClick={() => handleOAuthSignIn("google")}
                  >
                    <GoogleLogo />
                  </SubmitButton>
                </div>

                <div className="flex-1">
                  <SubmitButton
                    variant="outline"
                    className="p-2 w-full"
                    type="button"
                    showSpinner={false}
                    forceSpinner={oauthLoading === "github"}
                    disabled={passkeyVerifying || oauthLoading !== null}
                    onClick={() => handleOAuthSignIn("github")}
                  >
                    <GitHubLogo />
                  </SubmitButton>
                </div>

                <div className="flex-1">
                  <SubmitButton
                    variant="outline"
                    className="p-2 w-full"
                    type="button"
                    showSpinner={false}
                    forceSpinner={passkeyVerifying}
                    disabled={passkeyVerifying || oauthLoading !== null}
                    onClick={handlePasskeySignIn}
                  >
                    <KeyRound className="w-5 h-5" />
                  </SubmitButton>
                </div>
              </div>
            </CardContent>
          </Card>
          {legalLinks}
        </div>
      </div>
    </form>
  );
}

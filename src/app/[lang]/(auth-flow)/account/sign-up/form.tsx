"use client";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import Image from "next/image";
import { signUpWithEmailAction } from "./actions";
import { useState, useActionState } from "react";
import SubmitButton from "@/components/submit-button";
import { ErrorDisplay } from "@/components/error-display";
import { GitHubLogo, GoogleLogo } from "@/components/logo";
import { useTranslation } from "@/app/i18n/client";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/hooks/use-toast";

export default function Form({
  returnUrl,
  email,
  lang,
}: { returnUrl?: string; email?: string; lang: string }) {
  const [state, dispatch] = useActionState(signUpWithEmailAction, {});
  const { t } = useTranslation(lang);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const { toast } = useToast();

  const handleOAuthSignIn = async (provider: "google" | "github") => {
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

  return (
    <form action={dispatch}>
      <div className="h-screen flex items-center justify-center">
        <div className="w-[350px] flex flex-col gap-4 relative">
          <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
            <Image
              width={40}
              height={40}
              className="w-10 h-10 align-bottom"
              src="/img/logo_dark.svg"
              alt="Logo"
            />
            <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("auth:createAccount")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid w-full items-center gap-4">
                <div className="flex flex-col space-y-1.5">
                  <Label htmlFor="email">{t("auth:email")}</Label>
                  <Input
                    name="email"
                    id="email"
                    placeholder="me@example.com"
                    defaultValue={email}
                  />
                  {state.errors?.email && (
                    <ErrorDisplay errors={state.errors.email} />
                  )}
                </div>
                {state.message && (
                  <p className="text-sm font-medium text-destructive">
                    {state.message}
                  </p>
                )}
              </div>
              <input type="hidden" name="returnUrl" value={returnUrl} />
            </CardContent>
            <CardFooter className="block">
              <SubmitButton
                className="w-full"
                disabled={oauthLoading !== null}
              >
                {t("auth:signUp")}
              </SubmitButton>
              <Link
                href={`/${lang}/account/sign-in`}
                className="text-sm font-medium inline-block mt-6"
              >
                {t("auth:doYouHaveAnAccount")}
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
                    disabled={oauthLoading !== null}
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
                    disabled={oauthLoading !== null}
                    onClick={() => handleOAuthSignIn("github")}
                  >
                    <GitHubLogo />
                  </SubmitButton>
                </div>
              </div>
            </CardContent>
          </Card>
          <Link
            className="ml-auto text-sm absolute top-full right-0 translate-y-4"
            href={`/${lang}/docs/privacy`}
          >
            {t("privacy")}
          </Link>
        </div>
      </div>
    </form>
  );
}

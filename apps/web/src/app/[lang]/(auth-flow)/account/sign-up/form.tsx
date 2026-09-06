"use client";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import Link from "next/link";
import { signUpWithEmailAction } from "./actions";
import { useActionState } from "react";
import SubmitButton from "@beutl/ui/submit-button";
import { ErrorDisplay } from "@beutl/ui/error-display";
import { useTranslation } from "@beutl/ui/i18n-client";
import { GitHubLogo, GoogleLogo } from "@beutl/ui/logo";
import { AuthLogo } from "@/components/auth/auth-logo";
import { useOAuthSignIn } from "@/components/auth/oauth";

export default function Form({
  returnUrl,
  email,
  lang,
  legalLinks,
}: {
  returnUrl?: string;
  email?: string;
  lang: string;
  legalLinks: React.ReactNode;
}) {
  const [state, dispatch] = useActionState(signUpWithEmailAction, {});
  const { t } = useTranslation(lang);
  const { oauthLoading, handleOAuthSignIn } = useOAuthSignIn({ returnUrl, lang });

  return (
    <form action={dispatch}>
      <div className="h-screen flex items-center justify-center">
        <div className="w-[350px] flex flex-col gap-4 relative">
          <AuthLogo />
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
              <input type="hidden" name="returnUrl" value={returnUrl ?? ""} />
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
          {legalLinks}
        </div>
      </div>
    </form>
  );
}

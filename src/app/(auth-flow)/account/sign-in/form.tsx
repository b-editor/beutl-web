"use client";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { signInAction } from "./actions";
import { useFormState } from "react-dom";
import SubmitButton from "@/components/submit-button";
import type { SignInPageErrorParam } from "@auth/core/types";
import { useMemo, useState } from "react";
import { translateNextAuthError } from "@/lib/error-description";
import { ErrorDisplay } from "@/components/error-display";
import { GitHubLogo, GoogleLogo } from "@/components/logo";
import { useToast } from "@/hooks/use-toast";
import { signIn } from "next-auth/webauthn"

export default function Form({ returnUrl, error }: { returnUrl?: string, error?: SignInPageErrorParam }) {
  const [state, dispatch] = useFormState(signInAction, {});
  const authError = useMemo(() => translateNextAuthError(error), [error]);
  const [passkeyVerifying, setPasskeyVerifying] = useState(false);
  const { toast } = useToast();

  return (
    <form action={dispatch}>
      <div className="h-screen flex items-center justify-center">
        <div className="w-[350px] flex flex-col gap-4 relative">
          <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
            <Image width={40} height={40} className="w-10 h-10 align-bottom" src="/img/logo_dark.svg" alt="Logo" />
            <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>サインイン</CardTitle>
              <CardDescription>お使いのアカウントを使用</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid w-full items-center gap-4">
                <div className="flex flex-col space-y-1.5">
                  <Label htmlFor="email">メールアドレス</Label>
                  <Input name="email" id="email" placeholder="me@example.com" />
                  {state.errors?.email && <ErrorDisplay errors={state.errors.email} />}
                </div>
                {state?.message && <p className="text-sm font-medium text-destructive">{state?.message}</p>}
                {authError && <p className="text-sm font-medium text-destructive">{authError}</p>}
              </div>
              <input type="hidden" name="returnUrl" value={returnUrl} />
            </CardContent>
            <CardFooter className="block">
              <SubmitButton forceSpinner={passkeyVerifying} disabled={passkeyVerifying}
                className="w-full" name="type" value="email">サインイン</SubmitButton>
              <Link href="/account/sign-up" className="text-sm font-medium inline-block mt-6">アカウント作成</Link>
            </CardFooter>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex gap-4">
                <div className="flex-1">
                  <SubmitButton variant="outline" className="p-2 w-full" name="type" value="google" showSpinner={false} disabled={passkeyVerifying}>
                    <GoogleLogo />
                  </SubmitButton>
                </div>

                <div className="flex-1">
                  <SubmitButton variant="outline" className="p-2 w-full" name="type" value="github" showSpinner={false} disabled={passkeyVerifying}>
                    <GitHubLogo />
                  </SubmitButton>
                </div>

                <div className="flex-1">
                  <SubmitButton variant="outline" className="p-2 w-full" type="button" showSpinner={false}
                    disabled={passkeyVerifying} onClick={async () => {
                      setPasskeyVerifying(true);
                      try {
                        await signIn("passkey");
                      } catch {
                        toast({
                          title: "エラー",
                          description: "パスキーでサインインできませんでした",
                          variant: "destructive",
                        });
                      } finally {
                        setPasskeyVerifying(false);
                      }
                    }}>
                    <KeyRound className="w-5 h-5" />
                  </SubmitButton>
                </div>
              </div>
            </CardContent>
          </Card>
          <Link className="ml-auto text-sm absolute top-full right-0 translate-y-4" href="docs/privacy">プライバシーポリシー</Link>
        </div>
      </div>
    </form>
  )
}

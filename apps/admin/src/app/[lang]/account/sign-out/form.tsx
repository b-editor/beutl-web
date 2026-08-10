"use client";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@beutl/ui/ui/card";
import { useActionState } from "react";
import { signOutAction } from "./actions";
import SubmitButton from "@beutl/ui/submit-button";
import { useTranslation } from "@beutl/ui/i18n-client";

export default function Form({ lang }: { lang: string }) {
  const [, dispatch] = useActionState(signOutAction, undefined);
  const { t } = useTranslation(lang);

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("auth:signOut")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{t("auth:wouldYouLikeToSignOut")}</p>
          </CardContent>
          <CardFooter className="block">
            <form action={dispatch} className="w-full">
              <SubmitButton className="w-full" type="submit">
                {t("auth:signOut")}
              </SubmitButton>
            </form>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

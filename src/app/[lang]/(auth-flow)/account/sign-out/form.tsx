"use client";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Image from "next/image";
import { useFormState } from "react-dom";
import { signOutAction } from "./actions";
import SubmitButton from "@/components/submit-button";
import { useTranslation } from "@/app/i18n/client";

export default function Form({ lang }: { lang: string }) {
  const [, dispatch] = useFormState(signOutAction, undefined);
  const { t } = useTranslation(lang);

  return (
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

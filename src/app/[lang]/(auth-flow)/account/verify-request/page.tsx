import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import Image from "next/image";
import { getTranslation } from "@/app/i18n/server";

export default async function Page({
  params: { lang },
}: { params: { lang: string } }) {
  const { t } = await getTranslation(lang);
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
            <CardTitle>{t("auth:checkYourEmail")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{t("auth:emailSent")}</p>
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
  );
}

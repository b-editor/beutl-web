import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { getTranslation } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";

export default async function NotFound() {
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);

  return (
    <div className="h-screen flex items-center justify-center">
      <Card className="w-[350px]">
        <CardHeader>
          <CardTitle>{t("pageNotFound")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground">{t("pageNotFoundDescription")}</p>
          <Button asChild className="w-full">
            <Link href={`/${lang}`}>{t("backToHome")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

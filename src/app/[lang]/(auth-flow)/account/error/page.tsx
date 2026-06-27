import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { getTranslation } from "@/app/i18n/server";
import { AuthLogo } from "@/components/auth/auth-logo";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <AuthLogo />
        <Card>
          <CardHeader>
            <CardTitle>{t("auth:signInError")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-muted-foreground">
              {t("auth:signInErrorDescription")}
            </p>
            <Button asChild className="w-full">
              <Link href={`/${lang}/account/sign-in`}>
                {t("auth:backToSignIn")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

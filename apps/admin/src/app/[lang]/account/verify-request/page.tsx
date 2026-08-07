import { Card, CardContent, CardHeader, CardTitle } from "@beutl/ui/ui/card";
import { getTranslation } from "@beutl/i18n";
import { AuthLogo } from "@/components/auth/auth-logo";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;
  const { lang } = params;
  const { t } = await getTranslation(lang);

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <AuthLogo />
        <Card>
          <CardHeader>
            <CardTitle>{t("auth:checkYourEmail")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{t("auth:emailSent")}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { getTranslation } from "@beutl/i18n";
import Link from "next/link";
import { Button } from "@beutl/ui/ui/button";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;
  const { lang } = params;
  const { t } = await getTranslation(lang);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">403</h1>
      <p className="text-muted-foreground">{t("admin:common.forbidden")}</p>
      <Button variant="outline" asChild>
        <Link href={`/${lang}/account/sign-out`}>{t("admin:nav.signOut")}</Link>
      </Button>
    </div>
  );
}

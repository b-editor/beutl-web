import Link from "next/link";
import { getTranslation } from "@beutl/i18n";
import { cn } from "@beutl/core";

export async function AuthLegalLinks({
  lang,
  className,
  agreement = false,
}: {
  lang: string;
  className?: string;
  agreement?: boolean;
}) {
  const { t } = await getTranslation(lang);

  if (agreement) {
    return (
      <p className={cn("text-right text-xs leading-5 text-muted-foreground", className)}>
        {t("auth:legalNotice.prefix")}
        <Link className="text-foreground underline underline-offset-4" href={`/${lang}/docs/terms`}>
          {t("terms")}
        </Link>
        {t("auth:legalNotice.between")}
        {lang === "ja" && <br />}
        <span className={lang === "ja" ? "whitespace-nowrap" : undefined}>
          <Link className="text-foreground underline underline-offset-4" href={`/${lang}/docs/privacy`}>
            {t("privacy")}
          </Link>
          {t("auth:legalNotice.suffix")}
        </span>
      </p>
    );
  }

  return (
    <div className={cn("flex flex-wrap justify-end gap-x-3 gap-y-1 text-sm", className)}>
      <Link href={`/${lang}/docs/terms`}>{t("terms")}</Link>
      <Link href={`/${lang}/docs/privacy`}>{t("privacy")}</Link>
    </div>
  );
}

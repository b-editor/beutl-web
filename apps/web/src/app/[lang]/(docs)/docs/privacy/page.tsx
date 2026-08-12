import { getTranslation, type AvailableLanguage } from "@beutl/i18n";

type Props = {
  params: Promise<{ lang: string }>;
};

export default async function Page(props: Props) {
  const { lang } = await props.params;
  const { t } = await getTranslation(lang as AvailableLanguage);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        {t("privacy:title")}
      </h1>
      <p className="leading-7 not-first:mt-6">{t("privacy:intro")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:account.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:account.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:usageAnalytics.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">
        {t("privacy:usageAnalytics.body")}
      </p>
      <p className="leading-7 not-first:mt-6">
        {t("privacy:usageAnalytics.noAccountLink")}
      </p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:marketplace.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:marketplace.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:notCollected.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:notCollected.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:retention.title")}
      </h2>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>{t("privacy:retention.raw")}</li>
        <li>{t("privacy:retention.aggregate")}</li>
      </ul>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:control.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:control.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:sharing.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:sharing.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:contact.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:contact.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("privacy:changes.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("privacy:changes.body")}</p>
    </div>
  );
}

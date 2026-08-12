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
        {t("telemetry:title")}
      </h1>
      <p className="leading-7 not-first:mt-6">{t("telemetry:intro")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:activeInstallations.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">
        {t("telemetry:activeInstallations.body")}
      </p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:identifiers.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">
        {t("telemetry:identifiers.body")}
      </p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:collected.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("telemetry:collected.intro")}</p>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>{t("telemetry:collected.sessions")}</li>
        <li>{t("telemetry:collected.journey")}</li>
        <li>{t("telemetry:collected.quality")}</li>
        <li>{t("telemetry:collected.aggregation")}</li>
      </ul>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:notCollected.title")}
      </h2>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>{t("telemetry:notCollected.paths")}</li>
        <li>{t("telemetry:notCollected.identity")}</li>
        <li>{t("telemetry:notCollected.diagnostics")}</li>
      </ul>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:marketplace.title")}
      </h2>
      <p className="leading-7 not-first:mt-6">{t("telemetry:marketplace.body")}</p>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:storage.title")}
      </h2>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>{t("telemetry:storage.raw")}</li>
        <li>{t("telemetry:storage.aggregates")}</li>
        <li>{t("telemetry:storage.diagnostics")}</li>
      </ul>

      <h2 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        {t("telemetry:choice.title")}
      </h2>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>{t("telemetry:choice.optOut")}</li>
        <li>{t("telemetry:choice.reset")}</li>
        <li>{t("telemetry:choice.history")}</li>
      </ul>
    </div>
  );
}

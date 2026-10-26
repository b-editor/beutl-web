import { ScreenshotForm } from "./screenshot-form";
import { notFound } from "next/navigation";
import { retrievePackage } from "./actions/package";
import { PackageInfoForm } from "./package-info-form";
import { PackageDescriptionForm } from "./package-description-form";
import { PackageDetailsForm } from "./package-details-form";
import { PackagePricingForm } from "./package-pricing-form";
import { ReleaseForm } from "./release-form";
import { TranslationModeProvider } from "./translation-mode";
import { isAdmin } from "@beutl/core";
import { throwIfUnauth } from "@/lib/auth-guard";
import { languageLabels } from "@/lib/language-labels";
import { findAppReleaseAssetVersions } from "@beutl/db";
import SemVer from "semver";

export default async function Page(props: {
  params: Promise<{ lang: string; name: string }>;
}) {
  const params = await props.params;

  const {
    lang,
    name
  } = params;

  const session = await throwIfUnauth();
  const isAdminUser = isAdmin(session.user.id);
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  const languages = languageLabels(lang);
  // 既に翻訳が入っている言語だけを、表示言語メニューの切り替え候補にする。
  const translatedLanguages = [
    ...new Set([
      ...pkg.PackageTranslation.map((translation) => translation.lang),
      ...pkg.Release.flatMap((release) =>
        release.ReleaseTranslation.map((translation) => translation.lang),
      ),
    ]),
  ];

  let beutlVersions: string[] = [];
  try {
    beutlVersions = [...new Set(
      (await findAppReleaseAssetVersions({}))
        .map(({ version }) => SemVer.valid(version))
        .filter((version): version is string => version !== null),
    )].sort(SemVer.rcompare);
  } catch (error) {
    // Suggestions are optional; manual target-version entry remains available.
    console.error("Failed to load Beutl version suggestions", error);
  }

  return (
    <TranslationModeProvider
      languages={languages}
      initialLanguages={translatedLanguages}
    >
      <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
        <PackageInfoForm pkg={pkg} lang={lang} languages={languages} />

        {pkg.audience === "USER" && <ScreenshotForm pkg={pkg} lang={lang} />}

        <div className="flex max-lg:flex-col mt-6">
          <div className="lg:basis-2/3 lg:pr-6">
            {pkg.audience === "USER" && <PackageDescriptionForm pkg={pkg} lang={lang} languages={languages} />}
            <ReleaseForm pkg={pkg} lang={lang} languages={languages} beutlVersions={beutlVersions} ownerId={session.user.id} />
          </div>
          <div className="lg:basis-1/3">
            <PackageDetailsForm pkg={pkg} lang={lang} />
            {isAdminUser && pkg.audience === "USER" && <PackagePricingForm pkg={pkg} lang={lang} />}
          </div>
        </div>
      </div>
    </TranslationModeProvider>
  );
}

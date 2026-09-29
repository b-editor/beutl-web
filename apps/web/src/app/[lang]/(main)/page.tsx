import Link from "next/link";
import { Download } from "lucide-react";
import { getTranslation } from "@beutl/i18n";
import { cn } from "@beutl/core";
import EasingDemo, { EASING_CURVES } from "@/components/easing-demo";
import EffectsDemo from "@/components/effects-demo";
import FeaturesToc from "@/components/features-toc";
import BentoSection from "@/components/landing/bento-section";
import HeroSection from "@/components/landing/hero-section";
import ShowcaseSection from "@/components/landing/showcase-section";
import { retrieveLatestPackagesForLanding } from "@/lib/store-utils";
import {
  AudioMock,
  ExportMock,
  GpuMock,
  NodeGraphMock,
  PackagesMock,
  PlatformMock,
  ShaderCodeMock,
  TextMock,
  TimelineMock,
} from "@/components/landing/feature-mocks";
import {
  Chip,
  FeatureSection,
  LP_BUTTON_GHOST,
  LP_BUTTON_PRIMARY,
  LP_CTA_ROW,
  LP_SECTION,
  LP_WRAP,
} from "@/components/landing/lp-parts";

const LANDING_PACKAGE_COUNT = 2;
const DOWNLOAD_HREF = "https://github.com/b-editor/beutl/releases/latest";
const GITHUB_HREF = "https://github.com/b-editor/beutl";

const EASINGS = [
  {
    labelKey: "easeIn",
    path: EASING_CURVES.easeIn,
    color: "var(--color-lp-indigo-bright)",
  },
  {
    labelKey: "easeInOut",
    path: EASING_CURVES.easeInOut,
    color: "var(--color-lp-cyan)",
  },
  {
    labelKey: "easeOut",
    path: EASING_CURVES.easeOut,
    color: "var(--color-lp-coral)",
  },
  {
    labelKey: "easeElastic",
    path: EASING_CURVES.easeElastic,
    color: "var(--color-lp-lime)",
  },
  {
    labelKey: "easeBack",
    path: EASING_CURVES.easeBack,
    color: "var(--color-lp-indigo-bright)",
  },
  {
    labelKey: "easeBounce",
    path: EASING_CURVES.easeBounce,
    color: "var(--color-lp-coral)",
  },
];

const AUDIO_CHIPS = [
  "audioChipEq",
  "audioChipCompressor",
  "audioChipLimiter",
  "audioChipDelay",
];

export default async function Home(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const [{ t }, packages] = await Promise.all([
    getTranslation(lang),
    retrieveLatestPackagesForLanding(LANDING_PACKAGE_COUNT),
  ]);

  return (
    <main className="bg-lp-bg text-lp-text">
      <HeroSection
        downloadHref={DOWNLOAD_HREF}
        githubHref={GITHUB_HREF}
        texts={{
          eyebrow: t("main:heroEyebrow"),
          titleLine1: t("main:heroTitleLine1"),
          titleLine2: t("main:heroTitleLine2"),
          lede: t("main:heroLede"),
          download: t("main:download"),
          github: t("main:github"),
        }}
      />

      <ShowcaseSection
        label={t("main:showcaseLabel")}
        caption={t("main:showcaseCaption")}
      />

      <FeaturesToc lang={lang} />

      <FeatureSection
        tocId="features-timeline"
        eyebrow={t("main:timelineEyebrow")}
        headline={t("main:timelineHeadline")}
        body={t("main:timelineText")}
      >
        <TimelineMock t={t} />
      </FeatureSection>

      <FeatureSection
        tocId="features-nodes"
        eyebrow={t("main:nodeGraphEyebrow")}
        headline={t("main:nodeGraphHeadline")}
        body={t("main:nodeGraphText")}
      >
        <NodeGraphMock t={t} />
      </FeatureSection>

      <FeatureSection
        tocId="features-animation"
        eyebrow={t("main:animationEyebrow")}
        headline={t("main:animationHeadline")}
        body={t("main:animationText")}
      >
        <div className="grid grid-cols-3 gap-3 [&>*]:min-w-0">
          {EASINGS.map((easing) => (
            <EasingDemo
              key={easing.labelKey}
              path={easing.path}
              color={easing.color}
              label={t(`main:${easing.labelKey}`)}
            />
          ))}
        </div>
      </FeatureSection>

      <FeatureSection
        tocId="features-effects"
        eyebrow={t("main:effectsEyebrow")}
        headline={t("main:effectsHeadline")}
        body={t("main:effectsText")}
      >
        <EffectsDemo t={t} />
      </FeatureSection>

      <FeatureSection
        eyebrow={t("main:shaderEyebrow")}
        headline={t("main:shaderHeadline")}
        body={t("main:shaderText")}
      >
        <ShaderCodeMock />
      </FeatureSection>

      <FeatureSection
        tocId="features-audio"
        eyebrow={t("main:audioEyebrow")}
        headline={t("main:audioHeadline")}
        body={t("main:audioText")}
        extra={
          <div className="mt-[18px] flex flex-wrap gap-2">
            {AUDIO_CHIPS.map((key) => (
              <Chip key={key}>{t(`main:${key}`)}</Chip>
            ))}
          </div>
        }
      >
        <AudioMock />
      </FeatureSection>

      <FeatureSection
        eyebrow={t("main:textEyebrow")}
        headline={t("main:textHeadline")}
        body={t("main:textText")}
      >
        <TextMock t={t} />
      </FeatureSection>

      <FeatureSection
        eyebrow={t("main:gpuEyebrow")}
        headline={t("main:gpuHeadline")}
        body={t("main:gpuText")}
      >
        <GpuMock t={t} />
      </FeatureSection>

      <FeatureSection
        eyebrow={t("main:exportEyebrow")}
        headline={t("main:exportHeadline")}
        body={t("main:exportText")}
      >
        <ExportMock t={t} />
      </FeatureSection>

      <BentoSection t={t} />

      <FeatureSection
        eyebrow={t("main:crossPlatformEyebrow")}
        headline={t("main:crossPlatformHeadline")}
        body={t("main:crossPlatformText")}
        mockClassName="flex min-h-[220px] items-center justify-center"
      >
        <PlatformMock t={t} />
      </FeatureSection>

      <FeatureSection
        tocId="features-extensions"
        eyebrow={t("main:extensibleEyebrow")}
        headline={t("main:extensibleHeadline")}
        body={t("main:extensibleText")}
        extra={
          <Link
            href={`/${lang}/store`}
            className={cn(LP_BUTTON_GHOST, "mt-6")}
          >
            {t("main:browseExtensions")}
          </Link>
        }
      >
        <PackagesMock t={t} lang={lang} packages={packages} />
      </FeatureSection>

      <section className={LP_SECTION}>
        <div className={cn(LP_WRAP, "flex flex-wrap items-center justify-between gap-6")}>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              {t("main:finalHeadline")}
            </h2>
            <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-lp-muted">
              {t("main:finalText")}
            </p>
          </div>
          <div className={cn(LP_CTA_ROW, "mt-0")}>
            <Link href={DOWNLOAD_HREF} className={LP_BUTTON_PRIMARY}>
              <Download aria-hidden="true" />
              {t("main:download")}
            </Link>
            <Link href={GITHUB_HREF} className={LP_BUTTON_GHOST}>
              {t("main:viewOnGitHub")}
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

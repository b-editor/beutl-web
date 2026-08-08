import Link from "next/link";
import { getTranslation } from "@beutl/i18n";
import { cn } from "@beutl/core";
import EasingDemo, { EASING_CURVES } from "@/components/easing-demo";
import EffectsDemo from "@/components/effects-demo";
import FeaturesToc from "@/components/features-toc";
import AnimatedSection from "@/components/landing/animated-section";
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
  DownloadIcon,
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
    color: "#9A8CFF",
  },
  {
    labelKey: "easeInOut",
    path: EASING_CURVES.easeInOut,
    color: "#57D6E6",
  },
  {
    labelKey: "easeOut",
    path: EASING_CURVES.easeOut,
    color: "#FF7A6B",
  },
  {
    labelKey: "easeElastic",
    path: EASING_CURVES.easeElastic,
    color: "#C8F45C",
  },
  {
    labelKey: "easeBack",
    path: EASING_CURVES.easeBack,
    color: "#9A8CFF",
  },
  {
    labelKey: "easeBounce",
    path: EASING_CURVES.easeBounce,
    color: "#FF7A6B",
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
  const { t } = await getTranslation(lang);
  const packages = await retrieveLatestPackagesForLanding(LANDING_PACKAGE_COUNT);

  return (
    <div className="bg-lp-bg text-lp-text">
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
        reverse
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
        reverse
        tocId="features-effects"
        eyebrow={t("main:effectsEyebrow")}
        badge={t("main:effectsCount")}
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
        reverse
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
        reverse
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
        reverse
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
      >
        <PackagesMock t={t} lang={lang} packages={packages} />
      </FeatureSection>

      <section
        className={cn(LP_SECTION, "py-[clamp(64px,9vw,120px)] text-center")}
        style={{
          background:
            "radial-gradient(80% 120% at 50% 0%, rgba(109,92,247,0.18), transparent 60%)",
        }}
      >
        <AnimatedSection className={LP_WRAP}>
          <h2 className="text-[clamp(30px,5vw,52px)] font-extrabold tracking-[-0.02em] text-balance [overflow-wrap:anywhere]">
            {t("main:finalHeadline")}
          </h2>
          <p className="mx-auto mt-[18px] max-w-[44ch] text-[17px] text-lp-muted [overflow-wrap:anywhere]">
            {t("main:finalText")}
          </p>
          <div className={cn(LP_CTA_ROW, "justify-center")}>
            <Link href={DOWNLOAD_HREF} className={LP_BUTTON_PRIMARY}>
              <DownloadIcon />
              {t("main:download")}
            </Link>
            <Link href={GITHUB_HREF} className={LP_BUTTON_GHOST}>
              {t("main:viewOnGitHub")}
            </Link>
          </div>
        </AnimatedSection>
      </section>
    </div>
  );
}

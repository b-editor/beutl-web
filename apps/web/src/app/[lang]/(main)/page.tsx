import Link from "next/link";
import { headers } from "next/headers";
import { getTranslation } from "@beutl/i18n";
import { cn } from "@beutl/core";
import EasingDemo, { type EasingName } from "@/components/easing-demo";
import EffectsDemo from "@/components/effects-demo";
import FeaturesToc from "@/components/features-toc";
import BentoSection from "@/components/landing/bento-section";
import type { DownloadCtaProps } from "@/components/landing/download-cta";
import DownloadSection, { DOWNLOAD_SECTION_ID } from "@/components/landing/download-section";
import HeroSection from "@/components/landing/hero-section";
import ShowcaseSection from "@/components/landing/showcase-section";
import { detectPlatform } from "@/lib/app-download";
import { retrieveLatestAppReleaseForLanding } from "@/lib/app-release";
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
import { Chip, FeatureSection, LP_BUTTON_GHOST } from "@/components/landing/lp-parts";

const LANDING_PACKAGE_COUNT = 2;
const RELEASES_HREF = "https://github.com/b-editor/beutl/releases";
const GITHUB_HREF = "https://github.com/b-editor/beutl";

const EASINGS: { easing: EasingName; color: string }[] = [
  {
    easing: "easeIn",
    color: "var(--color-lp-indigo-bright)",
  },
  {
    easing: "easeInOut",
    color: "var(--color-lp-cyan)",
  },
  {
    easing: "easeOut",
    color: "var(--color-lp-coral)",
  },
  {
    easing: "easeElastic",
    color: "var(--color-lp-lime)",
  },
  {
    easing: "easeBack",
    color: "var(--color-lp-indigo-bright)",
  },
  {
    easing: "easeBounce",
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
  const [{ t }, packages, release, requestHeaders] = await Promise.all([
    getTranslation(lang),
    retrieveLatestPackagesForLanding(LANDING_PACKAGE_COUNT),
    retrieveLatestAppReleaseForLanding(),
    headers(),
  ]);

  // Without a registered release the button keeps its old destination.
  const downloadCta: DownloadCtaProps = {
    version: release?.version ?? null,
    downloads: release?.downloads ?? [],
    initialPlatform: detectPlatform(
      requestHeaders.get("user-agent"),
      requestHeaders.get("sec-ch-ua-platform"),
    ),
    fallbackHref: release ? `#${DOWNLOAD_SECTION_ID}` : `${RELEASES_HREF}/latest`,
    otherDownloadsHref: `#${DOWNLOAD_SECTION_ID}`,
    texts: {
      download: t("main:download"),
      downloadFor: {
        win: t("main:downloadForWindows"),
        osx: t("main:downloadForMacos"),
        linux: t("main:downloadForLinux"),
      },
      otherDownloads: t("main:otherDownloads"),
    },
  };

  return (
    <main className="bg-lp-bg text-lp-text">
      <HeroSection
        cta={downloadCta}
        githubHref={GITHUB_HREF}
        texts={{
          eyebrow: t("main:heroEyebrow"),
          titleLine1: t("main:heroTitleLine1"),
          titleLine2: t("main:heroTitleLine2"),
          lede: t("main:heroLede"),
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
              key={easing.easing}
              easing={easing.easing}
              color={easing.color}
              label={t(`main:${easing.easing}`)}
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

      <DownloadSection
        t={t}
        version={release?.version ?? null}
        downloads={release?.downloads ?? []}
        releasesHref={RELEASES_HREF}
      />
    </main>
  );
}

import NavBar from "@/components/nav-bar";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import FeaturesToc from "@/components/features-toc";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import EasingDemo from "@/components/easing-demo";
import EffectsDemo from "@/components/effects-demo";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Card, CardContent } from "@/components/ui/card";
import Footer from "@/components/footer";
import { getTranslation } from "@/app/i18n/server";
import { Code } from "lucide-react";

import HeroSection from "@/components/landing/hero-section";
import AnimatedSection from "@/components/landing/animated-section";
import StaggerChildren from "@/components/landing/stagger-children";
import PlatformIcons from "@/components/landing/platform-icons";
import animatedBorderStyles from "@/styles/animated-border.module.css";

function getExtensions(t: Awaited<ReturnType<typeof getTranslation>>["t"]) {
  return [
    {
      name: t("main:ffmpegLocator"),
      description: t("main:ffmpegLocatorDescription"),
      image:
        "https://beutl.beditor.net/api/contents/35750eb8-f9f6-43d2-8bd1-d54ad9589caf",
      borderGradient:
        "linear-gradient(135deg, #5C9A55 0%, #5E84E7 50%, #7B59F6 100%)",
    },
    {
      name: t("main:sugarShaker"),
      description: t("main:sugarShakerDescription"),
      image:
        "https://beutl.beditor.net/api/contents/cf85aadd-6439-4635-ba6e-d78c73c4853a",
      borderGradient:
        "linear-gradient(135deg, #ffffff 0%, #090C1D 50%, #ffffff 100%)",
    },
  ];
}

export default async function Home(props: {
  params: Promise<{ lang: string }>;
}) {
  const params = await props.params;
  const { lang } = params;
  const { t } = await getTranslation(lang);
  const extensions = getExtensions(t);

  return (
    <div>
      <NavBar lang={lang} />
      <div>
        {/* Hero Section */}
        <HeroSection
          texts={{
            unleashCreativity: t("main:unleashCreativity"),
            freeAndOpenSource: t("main:freeAndOpenSource"),
            download: t("main:download"),
          }}
        />

        {/* Features TOC */}
        <FeaturesToc lang={lang} />

        {/* Cross-Platform */}
        <AnimatedSection className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:items-center gap-8">
          <div className="lg:flex-1">
            <h3
              id="features-cross-platform"
              className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight"
            >
              {t("main:crossPlatform")}
            </h3>
            <p className="mt-8 text-lg leading-8">
              {t("main:crossPlatformText1")}
              <br />
              {t("main:crossPlatformText2")}
            </p>
            <Popover>
              <PopoverTrigger asChild>
                <Button className="mt-8" variant="outline">
                  {t("main:verifiedOS")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <h4 className="font-medium leading-none">
                      {t("main:verifiedOS")}
                    </h4>
                  </div>
                  <div>
                    <h5 className="border-b pb-2 text-lg font-semibold tracking-tight">
                      Windows
                    </h5>
                    <ul className="list-disc list-inside mt-2">
                      <li className="text-sm">Windows 11</li>
                    </ul>
                    <h5 className="border-b pb-2 text-lg font-semibold tracking-tight mt-4">
                      macOS
                    </h5>
                    <ul className="list-disc list-inside mt-2">
                      <li className="text-sm">macOS Sonoma 14.6.1</li>
                      <li className="text-sm">macOS Sequoia 15.1</li>
                    </ul>
                    <h5 className="border-b pb-2 text-lg font-semibold tracking-tight mt-4">
                      Linux
                    </h5>
                    <ul className="list-disc list-inside mt-2">
                      <li className="text-sm">Zorin OS 16</li>
                      <li className="text-sm">Ubuntu 22.04</li>
                    </ul>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <StaggerChildren className="flex gap-4 md:gap-6 justify-start mt-8">
              <PlatformIcons />
            </StaggerChildren>
          </div>

          <AnimatedSection delay={0.15} className="lg:flex-1">
            <Image
              className="rounded-lg"
              src="/img/cross-platform.png"
              alt="Cross platform"
              width={1920}
              height={1315}
            />
          </AnimatedSection>
        </AnimatedSection>

        {/* Animation */}
        <AnimatedSection className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:flex-row-reverse lg:items-center gap-8">
          <div className="lg:flex-1">
            <h3
              id="features-animation"
              className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight"
            >
              {t("main:animation")}
            </h3>
            <p className="mt-8 text-lg leading-8">
              {t("main:animationText")}
            </p>
          </div>

          <div className="lg:flex-1">
            <div className="grid grid-cols-3 gap-4 gap-y-12">
              <EasingDemo
                type="in"
                path="M1 84c14 1 47.75 1 123-83"
                easing="cubic-bezier(.12,0,.39,0)"
              />
              <EasingDemo
                type="out"
                path="M1 84C76.25 0 110 0 124 1"
                easing="cubic-bezier(.61,1,.88,1)"
              />
              <EasingDemo
                type="inOut"
                path="M1 84C46.25 85 78.75 0 124 1"
                easing="cubic-bezier(.37,0,.63,1)"
              />
              <EasingDemo
                type="in"
                path="M1 84c79 1 96.5 1 123-83"
                easing="cubic-bezier(.64,0,.78,0)"
              />
              <EasingDemo
                type="out"
                path="M1 84C27.5 0 45 0 124 1"
                easing="cubic-bezier(.22,1,.36,1)"
              />
              <EasingDemo
                type="inOut"
                path="M1 84C103.75 85 21.25 0 124 1"
                easing="cubic-bezier(.83,0,.17,1)"
              />
            </div>
          </div>
        </AnimatedSection>

        {/* Effects */}
        <AnimatedSection className="container mx-auto px-6 pt-12 md:px-12 lg:items-center gap-8">
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <h3
              id="features-effects"
              className="features-header text-center scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight"
            >
              {t("main:richEffects")}
            </h3>
            <span className="inline-flex items-center rounded-full bg-primary/10 border border-primary/20 px-3 py-1 text-xs font-semibold text-primary">
              28+
            </span>
          </div>
          <p className="mt-8 text-lg leading-8">{t("main:richEffectsText")}</p>
          <EffectsDemo lang={lang} />
        </AnimatedSection>

        {/* Extensions */}
        <AnimatedSection className="container mx-auto px-6 pt-12 pb-20 md:px-12 flex flex-col lg:grid lg:grid-cols-2 lg:items-center gap-8">
          <div className="lg:col-start-2 lg:row-start-1">
            <h3
              id="features-extensions"
              className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight"
            >
              {t("main:extensible")}
            </h3>
            <p className="mt-8 text-lg leading-8">
              {t("main:extensibleText")}
            </p>
          </div>

          <div className="lg:col-start-1 lg:row-start-1">
            <Carousel>
              <CarouselContent>
                {extensions.map((item) => (
                  <CarouselItem
                    key={item.name}
                    className={cn("basis-2/3 md:basis-1/2")}
                  >
                    <div className="p-1 h-full">
                      <Card className="h-full relative border-0">
                        <div
                          className="absolute inline-block -top-[1px] -left-[1px] -right-[1px] -bottom-[1px] -z-10 rounded-lg"
                          style={{ backgroundImage: item.borderGradient }}
                        />
                        <CardContent className="p-6">
                          <div className="flex">
                            <div className="flex-3">
                              <h4 className="text-xl font-semibold">
                                {item.name}
                              </h4>
                              <span className="text-muted-foreground text-sm">
                                {t("main:officialPackage")}
                              </span>
                            </div>
                            <Image
                              width={64}
                              height={64}
                              className="flex-1 w-16 h-16 max-w-fit rounded-md"
                              alt="Package icon"
                              src={item.image}
                            />
                          </div>
                          <p className="text-sm mt-4">{item.description}</p>
                        </CardContent>
                      </Card>
                    </div>
                  </CarouselItem>
                ))}
                <CarouselItem className="basis-2/3 md:basis-1/2">
                  <div className="p-1 h-full">
                    <div
                      className={cn(
                        animatedBorderStyles.animatedBorder,
                        "h-full",
                      )}
                    >
                      <Card className="h-full border-0 bg-card">
                        <CardContent className="p-6 flex flex-col items-center justify-center h-full gap-3 text-center">
                          <Code className="w-8 h-8 text-primary" />
                          <p className="text-lg font-semibold">
                            {t("main:buildExtensions")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {t("main:buildExtensionsDescription")}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                </CarouselItem>
              </CarouselContent>
              <CarouselPrevious className="left-1 top-[calc(100%+2rem)]" />
              <CarouselNext className="right-1 top-[calc(100%+2rem)]" />
            </Carousel>
          </div>
        </AnimatedSection>
      </div>
      <Footer lang={lang} />
    </div>
  );
}

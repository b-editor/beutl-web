import NavBar from "@/components/nav-bar";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import FeaturesToc from "@/components/features-toc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import EasingDemo from "@/components/easing-demo";
import EffectsDemo from "@/components/effects-demo";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { Card, CardContent } from "@/components/ui/card";
import Footer from "@/components/footer";
import styles from "@/styles/fluid.module.css";
import Link from "next/link";
import { getTranslation } from "@/app/i18n/server";
import { Awaited } from "@auth/core/types";

function getExtensions(t: Awaited<ReturnType<typeof getTranslation>>["t"]) { 
  return [
    {
      name: t("main:ffmpegLocator"),
      description: t("main:ffmpegLocatorDescription"),
      image: "https://beutl.beditor.net/api/v1/assets/b-editor/ffmpeg-locator.png/download",
      borderGradient: "linear-gradient(135deg, #5C9A55 0%, #5E84E7 50%, #7B59F6 100%)"
    },
    {
      name: t("main:sugarShaker"),
      description: t("main:sugarShakerDescription"),
      image: "https://beutl.beditor.net/api/v1/assets/b-editor/sugar-shaker-logo.jpg/download",
      borderGradient: "linear-gradient(135deg, #ffffff 0%, #090C1D 50%, #ffffff 100%)"
    },
    {
      name: t("main:cefSample"),
      description: t("main:cefSampleDescription"),
      image: "https://beutl.beditor.net/api/v1/assets/b-editor/icon/download",
      borderGradient: "linear-gradient(135deg, #693AF4 0%, #D0D2D2 100%)"
    }
  ];
}

export default async function Home({ params: { lang } }: { params: { lang: string } }) {
  const { t } = await getTranslation(lang);
  const extensions = getExtensions(t);

  return (
    <div>
      <NavBar lang={lang} />
      <div>
        <div className={cn(styles.fluid, "m-auto w-[70vw] h-[70vw] md:w-[50vw] md:h-[50vw] blur-md md:blur-xl absolute top-0 left-1/2 -translate-x-1/2 max-md:translate-y-1/2 select-none pointer-events-none -z-10")} />

        <div className="container mx-auto px-6 pt-12 md:px-12">

          <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl lg:mt-8">
            {t("main:unleashCreativity")}
          </h1>
          <h2 className="scroll-m-20 mt-8 pb-2 text-xl md:text-3xl font-medium tracking-tight">
            {t("main:freeAndOpenSource")}
          </h2>
          <Button className="mt-6 border" asChild>
            <Link href="https://github.com/b-editor/beutl/releases/latest">
              <Download className="w-5 h-5 mr-2" />{t("main:download")}
            </Link>
          </Button>
          <Button variant="link" className="mt-6 text-foreground ml-4 border backdrop-brightness-75" asChild>
            <Link href="https://github.com/b-editor/beutl">
              <img src="/img/github-color.svg" alt="GitHub" className="w-5 h-5 mr-2 invert" />
              GitHub
            </Link>
          </Button>

          <div className="mt-16 md:mt-8 mx-auto select-none pointer-events-none">
            <Image className="scale-[107.5%]" src="/img/brand-image2.png" alt="brand image" width={1920} height={1080} />
          </div>
        </div>

        <div className="bg-[hsl(var(--card)/60%)] py-4" />
        <FeaturesToc lang={lang} />
        <div className="bg-[hsl(var(--card)/60%)] py-4" />

        <div className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:items-center gap-8">

          <div className="lg:flex-1">
            <h3 id="features-cross-platform" className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
              {t("main:crossPlatform")}
            </h3>
            <p className="mt-8 text-lg leading-8">
              {t("main:crossPlatformText1")}<br />
              {t("main:crossPlatformText2")}
            </p>
            <Popover>
              <PopoverTrigger asChild>
                <Button className="mt-8" variant="outline">{t("main:verifiedOS")}</Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <h4 className="font-medium leading-none">{t("main:verifiedOS")}</h4>
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
          </div>

          <div className="lg:flex-1">
            <Image className="rounded" src="/img/cross-platform.png" alt="Cross platform" width={1920} height={1315} />
          </div>

        </div>
        <div className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:flex-row-reverse lg:items-center gap-8">

          <div className="lg:flex-1">
            <h3 id="features-animation" className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
              {t("main:animation")}
            </h3>
            <p className="mt-8 text-lg leading-8">
              {t("main:animationText")}
            </p>
            {/* <Button className="mt-8" variant="outline">利用可能なアニメーション</Button> */}
          </div>

          <div className="lg:flex-1">
            <div className="grid grid-cols-3 gap-4 gap-y-12">
              <EasingDemo type="in" path="M1 84c14 1 47.75 1 123-83" easing="cubic-bezier(.12,0,.39,0)" />
              <EasingDemo type="out" path="M1 84C76.25 0 110 0 124 1" easing="cubic-bezier(.61,1,.88,1)" />
              <EasingDemo type="inOut" path="M1 84C46.25 85 78.75 0 124 1" easing="cubic-bezier(.37,0,.63,1)" />
              <EasingDemo type="in" path="M1 84c79 1 96.5 1 123-83" easing="cubic-bezier(.64,0,.78,0)" />
              <EasingDemo type="out" path="M1 84C27.5 0 45 0 124 1" easing="cubic-bezier(.22,1,.36,1)" />
              <EasingDemo type="inOut" path="M1 84C103.75 85 21.25 0 124 1" easing="cubic-bezier(.83,0,.17,1)" />
            </div>
          </div>

        </div>
        <div className="container mx-auto px-6 pt-12 md:px-12 lg:items-center gap-8">
          <h3 id="features-effects" className="features-header text-center scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
            {t("main:richEffects")}
          </h3>
          <p className="mt-8 text-lg leading-8 ">
            {t("main:richEffectsText")}
          </p>
          <EffectsDemo lang={lang} />
        </div>
        <div className="container mx-auto px-6 pt-12 pb-20 md:px-12 flex flex-col lg:grid lg:grid-cols-2 lg:items-center gap-8">

          <div className="lg:col-start-2 lg:row-start-1">
            <h3 id="features-extensions" className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
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
                  <CarouselItem key={item.name} className={cn("basis-2/3 md:basis-1/2")}>
                    <div className="p-1 h-full">
                      <Card className="h-full relative border-0">
                        <div className="absolute inline-block -top-[1px] -left-[1px] -right-[1px] -bottom-[1px] -z-10 rounded-lg"
                          style={{ backgroundImage: item.borderGradient }} />
                        <CardContent className="p-6">
                          <div className="flex">
                            <div className="flex-[3]">
                              <h4 className="text-xl font-semibold">{item.name}</h4>
                              <span className="text-muted">{t("main:officialPackage")}</span>
                            </div>
                            <Image width={64} height={64}
                              className="flex-1 w-16 h-16 max-w-fit rounded-md"
                              alt="Package icon" src={item.image} />
                          </div>
                          <p className="text-sm mt-4">{item.description}</p>
                        </CardContent>
                      </Card>
                    </div>
                  </CarouselItem>
                ))}
                <CarouselItem className="basis-2/3 md:basis-1/2">
                  <div className="p-1 h-full">
                    <Card className="h-full">
                      <CardContent className="p-6">
                        <p className="text-xl font-semibold text-wrap" style={{ overflowWrap: "anywhere" }}>
                          {t("main:stillWorking")}
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                </CarouselItem>
              </CarouselContent>
              <CarouselPrevious className="left-1 top-[calc(100%+2rem)]" />
              <CarouselNext className="right-1 top-[calc(100%+2rem)]" />
            </Carousel>
          </div>

        </div>

        {/* <div className="container mx-auto px-6 py-12 md:px-12">
          <h3 className="text-2xl md:text-4xl font-semibold tracking-tight">新機能</h3>
        </div>

        <div className="container mx-auto px-6 py-12 md:px-12">
          <h3 className="text-2xl md:text-4xl font-semibold tracking-tight">製品ニュース</h3>
        </div> */}
      </div>
      <Footer />
    </div>
  );
}

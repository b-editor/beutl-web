"use client";
import { useMatchMedia } from "@/hooks/use-match-media";
import Link from "next/link";
import { Button } from "@beutl/ui/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { formatAmount } from "@beutl/core";
import type { Package } from "@/lib/store-utils";
import { useTranslation } from "@beutl/ui/i18n-client";

export function PackageDetails({
  pkg,
  price,
  currency,
  lang,
}: {
  pkg: Package;
  price: number;
  currency: string;
  lang: string;
}) {
  const { t } = useTranslation(lang);
  const maxLg = useMatchMedia("(min-width: 1024px)", false);
  return (
    <>
      <div className="max-sm:relative sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4 max-sm:flex-col">
          <div className="flex gap-4">
            {pkg.iconFileUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                className="w-16 h-16 max-w-fit rounded-md"
                alt="Package icon"
                src={pkg.iconFileUrl}
              />
            )}
            {!pkg.iconFileUrl && (
              <div className="w-16 h-16 rounded-md bg-secondary" />
            )}
            <div>
              <h2 className="font-bold text-2xl">
                {pkg.displayName || pkg.name}
              </h2>
              <Button
                asChild
                variant="link"
                className="p-0 h-auto text-muted-foreground"
              >
                <Link href="/">{pkg.user.Profile?.userName}</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-4 text-foreground/70">{pkg.shortDescription}</p>
      <div className="mt-4 text-3xl font-bold">
        {formatAmount(price, currency, lang)}
      </div>
      <div className="max-lg:hidden">
        {pkg.PackageScreenshot && pkg.PackageScreenshot.length > 0 && (
          <>
            <h3 className="font-bold text-xl mt-6 border-b pb-2">
              {t("store:screenshots")}
            </h3>
            <Carousel className="mt-4" opts={{ active: maxLg }}>
              <CarouselContent className="max-lg:overflow-x-scroll max-lg:hidden-scrollbar">
                {pkg.PackageScreenshot.map((item) => (
                  <CarouselItem
                    className="w-min max-w-min min-w-min"
                    key={item.file.id}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */ }
                    <img
                      className="rounded h-80 aspect-auto"
                      alt="Screenshot"
                      src={item.url}
                    />
                  </CarouselItem>
                ))}
              </CarouselContent>
              <CarouselPrevious className="max-lg:hidden left-0 -translate-x-1/2 w-8 h-8" />
              <CarouselNext className="max-lg:hidden right-0 translate-x-1/2 w-8 h-8" />
            </Carousel>
          </>
        )}
      </div>
    </>
  );
}

"use client";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useMatchMedia } from "@/hooks/use-match-media";
import Image from "next/image";
import Link from "next/link";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { formatAmount } from "@/lib/currency-formatter";
import type { Package } from "@/lib/store-utils";
import { useTranslation } from "@/app/i18n/client";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY as string,
);

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
              <Image
                width={64}
                height={64}
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
                    <Image
                      className="rounded max-w-min h-80 aspect-auto"
                      alt="Screenshot"
                      width={1280}
                      height={720}
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

export function ClientPage({
  clientSecret,
  email,
  lang,
  name,
}: {
  clientSecret: string | null;
  email: string;
  lang: string;
  name: string;
}) {
  return (
    <>
      {clientSecret && (
        <Elements
          options={{
            clientSecret,
            appearance: {
              theme: "night",
              variables: {
                colorPrimary: "hsl(300 9% 98%)",
                colorBackground: "hsl(240 7% 8%)",
              },
              rules: {
                ".AccordionItem": {
                  // backgroundColor: "hsl(240 7% 8%)",
                  backgroundColor: "transparent",
                  boxShadow: "none",
                  borderWidth: "0px",
                  paddingLeft: "12px",
                  paddingRight: "12px",
                },
                ".Block": {
                  backgroundColor: "transparent",
                  boxShadow: "none",
                  borderWidth: "0px",
                },
                ".Input": {
                  backgroundColor: "hsl(240 7% 8%)",
                  color: "hsl(0 0% 100%)",
                  borderColor: "hsl(248 9% 18%)",
                  borderWidth: "1px",
                  borderRadius: "calc(0.5rem - 2px)",
                  borderStyle: "solid",
                  padding: "0.75rem 0.5rem",
                  transition: "none",
                  boxShadow: "none",
                },
                ".Input:focus": {
                  outline: "2px solid transparent",
                  outlineOffset: "2px",
                  boxShadow:
                    "0 0 0 2px hsl(240 7% 8%), 0 0 0 4px hsl(243 86% 40%), #00000000 0 0 0 0",
                  borderColor: "hsl(248 9% 18%)",
                },
                ".PickerItem--selected": {
                  marginLeft: "0.75rem",
                  marginRight: "0.75rem",
                },
                ".TermsText": {
                  marginLeft: "0.75rem",
                  marginRight: "0.75rem",
                },
              },
            },
          }}
          stripe={stripePromise}
        >
          <CheckoutForm email={email} name={name} lang={lang} />
        </Elements>
      )}
    </>
  );
}

function CheckoutForm({
  lang,
  name,
  email,
}: { lang: string; name: string; email: string }) {
  const { t } = useTranslation(lang);
  const stripe = useStripe();
  const elements = useElements();

  const [message, setMessage] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsLoading(true);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${location.origin}/${lang}/store/${name}/checkout/complete`,
      },
    });

    if (error.type === "card_error" || error.type === "validation_error") {
      setMessage(error.message);
    } else {
      setMessage("An unexpected error occurred.");
    }

    setIsLoading(false);
  };

  return (
    <form
      id="payment-form"
      onSubmit={handleSubmit}
      className="h-full flex flex-col justify-between"
    >
      <PaymentElement
        id="payment-element"
        options={{
          layout: "accordion",
          defaultValues: {
            billingDetails: {
              email,
            },
          },
        }}
      />
      <div className="mx-3 mt-2 flex flex-col gap-2">
        {message && <div>{message}</div>}
        <Button
          size="lg"
          variant="default"
          disabled={isLoading || !stripe || !elements}
          id="submit"
        >
          {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {t("store:pay")}
        </Button>
      </div>
    </form>
  );
}

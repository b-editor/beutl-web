import { createStripe } from "@/lib/stripe/config";
import { ClientPage } from "./components";
import { notFound } from "next/navigation";
import { PackageDetails } from "../components";
import { retrievePackage } from "@/lib/store-utils";

export default async function Page(
  props: {
    params: Promise<{ name: string; lang: string }>;
    searchParams: Promise<{ payment_intent: string }>;
  }
) {
  const searchParams = await props.searchParams;

  const {
    payment_intent
  } = searchParams;

  const params = await props.params;

  const {
    name,
    lang
  } = params;

  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }

  const stripe = createStripe();
  const intent = await stripe.paymentIntents.retrieve(payment_intent);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative flex max-md:flex-col gap-2">
        <div className="md:flex-1 mx-3 min-w-0">
          <PackageDetails
            pkg={pkg}
            price={intent.amount}
            currency={intent.currency}
            lang={lang}
          />
        </div>
        <div className="border max-md:h-[1px] md:w-[1px]" />
        <div className="md:flex-1 mx-2 max-md:mt-4">
          <ClientPage status={intent.status} name={name} lang={lang} />
        </div>
      </div>
    </div>
  );
}

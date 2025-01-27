import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveCustomerId } from "@/lib/customer";
import { createStripe } from "@/lib/stripe/config";
import { ClientPage, PackageDetails } from "./components";
import { notFound, redirect } from "next/navigation";
import { guessCurrency } from "@/lib/currency";
import {
  packageOwned,
  retrievePackage,
  retrievePrices,
} from "@/lib/store-utils";

export default async function Page({
  params: { name, lang },
}: {
  params: { name: string; lang: string };
}) {
  const session = await authOrSignIn();
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  if (await packageOwned(pkg.id, session.user.id)) {
    redirect(`/store/${name}`);
  }
  const currencyP = guessCurrency();
  const prices = await retrievePrices(pkg.id);
  const currency = await currencyP;
  const price =
    prices.find((p) => p.currency === currency) ||
    prices.find((p) => p.fallback) ||
    prices[0];
  if (!price) {
    throw new Error("No price found");
  }

  const customerId = await createOrRetrieveCustomerId(
    session.user.email as string,
    session.user.id,
  );
  const stripe = createStripe();
  const intents = await stripe.paymentIntents.search({
    query: `customer:"${customerId}" AND metadata["packageId"]:"${pkg.id}" AND amount:${price.price} AND currency:"${price.currency}" AND status:"requires_payment_method"`,
    limit: 1,
  });

  const paymentIntent =
    intents.data[0] ||
    (await stripe.paymentIntents.create({
      customer: customerId,
      setup_future_usage: "off_session",
      amount: price.price,
      currency: price.currency,
      metadata: {
        packageId: pkg.id,
      },
      // In the latest version of the API, specifying the `automatic_payment_methods` parameter is optional because Stripe enables its functionality by default.
      automatic_payment_methods: {
        enabled: true,
      },
    }));

  const clientSecret = paymentIntent.client_secret;

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative flex max-md:flex-col gap-2">
        <div className="md:flex-1 mx-3 min-w-0">
          <PackageDetails
            pkg={pkg}
            price={price.price}
            currency={price.currency}
            lang={lang}
          />
        </div>
        <div className="border max-md:h-[1px] md:w-[1px]" />
        <div className="md:flex-1">
          <ClientPage
            name={name}
            email={session.user.email as string}
            lang={lang}
            clientSecret={clientSecret}
          />
        </div>
      </div>
    </div>
  );
}

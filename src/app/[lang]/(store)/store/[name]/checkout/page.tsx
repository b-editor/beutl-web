import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveCustomerId } from "@/lib/customer";
import { stripe } from "@/lib/stripe/config";
import { ClientPage, PackageDetails } from "./components";
import { retrievePackage } from "../actions";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/prisma";
import { guessCurrency } from "@/lib/currency";

async function packageOwned(pkgId: string, userId: string) {
  return !!await prisma.userPackage.findFirst({
    where: {
      userId: userId,
      packageId: pkgId
    }
  });
}

async function retrievePrices(pkgId: string) {
  return await prisma.packagePricing.findMany({
    where: {
      packageId: pkgId
    },
    select: {
      currency: true,
      price: true,
      fallback: true
    }
  });
}

const zeroDecimalCurrencies = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];

function formatAmount(amount: number, currency: string, lang: string) {
  const formatter = new Intl.NumberFormat(lang, {
    style: 'currency',
    currency: currency,
  });

  if (zeroDecimalCurrencies.includes(currency.toUpperCase())) {
    return formatter.format(amount);
  } else {
    return formatter.format(amount / 100);
  }
}

export default async function Page({
  params: { name, lang },
}: {
  params: { name: string, lang: string },
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
  const price = prices.find(p => p.currency === currency) || prices.find(p => p.fallback) || prices[0];
  if (!price) {
    throw new Error("No price found");
  }

  const customerId = await createOrRetrieveCustomerId(session.user.email as string, session.user.id);
  const intents = await stripe.paymentIntents.search({
    query: `customer:"${customerId}" AND metadata["packageId"]:"${pkg.id}" AND amount:${price.price} AND currency:"${price.currency}" AND status:"requires_payment_method"`,
    limit: 1
  });

  const paymentIntent = intents.data[0] || await stripe.paymentIntents.create({
    customer: customerId,
    setup_future_usage: "off_session",
    amount: price.price,
    currency: price.currency,
    metadata: {
      packageId: pkg.id
    },
    // In the latest version of the API, specifying the `automatic_payment_methods` parameter is optional because Stripe enables its functionality by default.
    automatic_payment_methods: {
      enabled: true,
    },
  });

  const clientSecret = paymentIntent.client_secret;

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 pr-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative md:flex sm:gap-2">
        <div className="flex-1 mx-3">
          <PackageDetails
            pkg={pkg}
          />
        </div>
        <div className="border w-[1px]" />
        <div className="flex-1 flex flex-col">
          <p className="max-lg:mt-4 mb-4 mx-3 font-bold text-3xl">{formatAmount(price.price, currency, lang)}</p>
          <div className="flex-1">
            <ClientPage
              name={name}
              lang={lang}
              clientSecret={clientSecret}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
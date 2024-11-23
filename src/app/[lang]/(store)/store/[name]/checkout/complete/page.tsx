import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveCustomerId } from "@/lib/customer";
import { stripe } from "@/lib/stripe/config";
import { ClientPage } from "./components";
import { notFound, redirect } from "next/navigation";
import { SemVer } from "semver";
import { prisma } from "@/prisma";
import { guessCurrency } from "@/lib/currency";
import { PackageDetails } from "../components";
import { formatAmount } from "@/lib/currency-formatter";
import { retrievePackage } from "@/lib/store-utils";

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

export default async function Page({
  params: { name, lang },
  searchParams: { payment_intent }
}: {
  params: { name: string, lang: string },
  searchParams: { payment_intent: string }
}) {
  const session = await authOrSignIn();
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  if (await packageOwned(pkg.id, session.user.id)) {
    redirect(`/store/${name}`);
  }

  const intent = await stripe.paymentIntents.retrieve(payment_intent);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative flex max-md:flex-col gap-2">
        <div className="md:flex-1 mx-3">
          <PackageDetails
            pkg={pkg}
            price={intent.amount}
            currency={intent.currency}
            lang={lang}
          />
        </div>
        <div className="border max-md:h-[1px] md:w-[1px]" />
        <div className="md:flex-1 mx-2 max-md:mt-4">
          <ClientPage
            status={intent.status}
            name={name}
            lang={lang}
          />
        </div>
      </div>
    </div>
  )
}
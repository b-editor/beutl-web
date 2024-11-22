import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveCustomerId } from "@/lib/customer";
import { stripe } from "@/lib/stripe/config";
import { ClientPage } from "./components";
import { retrievePackage } from "../../actions";
import { notFound, redirect } from "next/navigation";
import { SemVer } from "semver";
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
    <div className="max-w-5xl mx-auto py-10 lg:py-6 pl-4 lg:pl-6 pr-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      {/* <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4"> */}
      <div className="max-sm:relative md:flex sm:gap-2">
        <div className="flex-1">

        </div>
        <div className="border w-[1px]" />
        <div className="flex-1">
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
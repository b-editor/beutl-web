import { ClientPage } from "./components";
import { notFound } from "next/navigation";
import { SemVer } from "semver";
import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { guessCurrency } from "@/lib/currency";
import { packageOwned, retrievePackage, retrievePrices } from "@/lib/store-utils";

type Props = {
  params: {
    name: string;
  };
  searchParams: {
    message?: "PleaseOpenDesktopApp";
  }
}

export default async function Page({ params: { name }, searchParams: { message } }: Props) {
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  pkg.Release.sort((a, b) => {
    return new SemVer(b.version).compare(a.version);
  });
  const currencyP = guessCurrency();
  const prices = await retrievePrices(pkg.id);
  const currency = await currencyP;
  const price = prices.find(p => p.currency === currency) || prices.find(p => p.fallback) || prices[0];
  const session = await auth();
  let owned = false;
  if (session?.user?.id) {
    owned = await packageOwned(pkg.id, session.user.id);
  }

  return (
    <ClientPage pkg={pkg} owned={owned} message={message} />
  )
}
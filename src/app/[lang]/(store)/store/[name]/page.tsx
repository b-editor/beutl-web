import { ClientPage } from "./components";
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SemVer } from "semver";
import { auth } from "@/lib/better-auth";
import { guessCurrency } from "@/lib/currency";
import { selectPricing } from "@/lib/pricing";
import {
  packageOwned,
  packagePaied,
  retrievePackage,
  retrievePrices,
} from "@/lib/store-utils";
import { headers } from "next/headers";

const getPackage = cache((name: string) => retrievePackage(name));

type Props = {
  params: Promise<{
    lang: string;
    name: string;
  }>;
  searchParams: Promise<{
    message?: "PleaseOpenDesktopApp";
  }>;
};

export async function generateMetadata(props: {
  params: Promise<{ lang: string; name: string }>;
}): Promise<Metadata> {
  const { name } = await props.params;
  const pkg = await getPackage(name);
  if (!pkg) {
    return {};
  }
  const title = pkg.displayName || name;
  return {
    title,
    description: pkg.shortDescription,
    openGraph: {
      title,
      description: pkg.shortDescription,
    },
  };
}

export default async function Page(props: Props) {
  const searchParams = await props.searchParams;

  const {
    message
  } = searchParams;

  const params = await props.params;

  const {
    lang,
    name
  } = params;

  const pkg = await getPackage(name);
  if (!pkg) {
    notFound();
  }
  pkg.Release.sort((a, b) => {
    return new SemVer(b.version).compare(a.version);
  });
  const currencyP = guessCurrency();
  const prices = await retrievePrices(pkg.id);
  const currency = await currencyP;
  const price = selectPricing(prices, currency);
  const session = await auth.api.getSession({ headers: await headers() });
  let owned = false;
  let paied = false;
  if (session?.user?.id) {
    [owned, paied] = await Promise.all([
      packageOwned(pkg.id, session.user.id),
      packagePaied(pkg.id, session.user.id),
    ]);
  }

  return (
    <ClientPage
      pkg={pkg}
      owned={owned}
      message={message}
      lang={lang}
      price={price}
      paied={paied}
    />
  );
}

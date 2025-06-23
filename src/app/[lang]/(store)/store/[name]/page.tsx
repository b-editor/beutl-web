import { ClientPage } from "./components";
import { notFound } from "next/navigation";
import { SemVer } from "semver";
import { auth } from "@/auth";
import { guessCurrency } from "@/lib/currency";
import {
  packageOwned,
  packagePaied,
  retrievePackage,
  retrievePrices,
} from "@/lib/store-utils";

type Props = {
  params: Promise<{
    lang: string;
    name: string;
  }>;
  searchParams: Promise<{
    message?: "PleaseOpenDesktopApp";
  }>;
};

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

  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  pkg.releases.sort((a: typeof pkg.releases[number], b: typeof pkg.releases[number]) => {
    return new SemVer(b.version).compare(a.version);
  });
  const currencyP = guessCurrency();
  const prices = await retrievePrices(pkg.id);
  const currency = await currencyP;
  const price =
    prices.find((p) => p.currency === currency) ||
    prices.find((p) => p.fallback) ||
    prices[0];
  const session = await auth();
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

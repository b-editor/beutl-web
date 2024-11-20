import { ClientPage } from "./components";
import { retrievePackage } from "./actions";
import { notFound } from "next/navigation";
import { SemVer } from "semver";
import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { guessCurrency } from "@/lib/currency";

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
  const session = await auth();
  let owned = false;
  if (session?.user?.id) {
    const up = await prisma.userPackage.findFirst({
      where: {
        userId: session.user.id,
        packageId: pkg.id
      }
    });
    owned = up !== null;
  }
  await guessCurrency();

  return (
    <ClientPage pkg={pkg} owned={owned} message={message} />
  )
}
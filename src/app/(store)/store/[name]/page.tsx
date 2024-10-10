import api, { type ReleaseResponse } from "@/lib/api";
import { ClientPage } from "./components";
import { retrievePackage } from "./actions";
import { notFound } from "next/navigation";
import { SemVer } from "semver";

export default async function Page({ params: { name } }: { params: { name: string } }) {
  const pkg = await retrievePackage(name);
  if (!pkg) {
    notFound();
  }
  pkg.Release.sort((a, b) => {
    return new SemVer(a.version).compare(b.version);
  });

  return (
    <ClientPage pkg={pkg} />
  )
}
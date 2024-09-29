import api, { type ReleaseResponse } from "@/lib/api";
import { ClientPage } from "./components";

export default async function Page({ params: { name } }: { params: { name: string } }) {
  const pkg = await api.packages.getPackage(name);
  const releases: ReleaseResponse[] = [];
  let start = 0;
  let getCount = 0;
  do {
    const items = await api.releases.getReleases(name, start, 30);
    releases.push(...items);
    start += items.length;
    getCount = items.length;
  } while (getCount === 30)

  return (
    <ClientPage pkg={pkg} releases={releases} />
  )
}
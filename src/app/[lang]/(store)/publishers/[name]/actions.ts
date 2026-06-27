import "server-only";
import { contentPath } from "@/lib/content-url";
import { guessCurrency } from "@/lib/currency";
import { retrievePublishedPackagesByUserName } from "@/lib/db/package";
import { getProfileDisplayNameByUserName } from "@/lib/db/profile";
import { selectPricing } from "@/lib/pricing";

type ListedPackage = {
  id: string;
  name: string;
  displayName?: string;
  shortDescription: string;
  userName?: string;
  iconFileUrl?: string;
  tags: string[];
  price?: {
    price: number;
    currency: string;
  };
};

export async function retrievePublishedPackages(
  userName: string,
): Promise<{ items: ListedPackage[]; displayName: string }> {
  const currency = await guessCurrency();
  const profile = getProfileDisplayNameByUserName({
    userName,
  });
  const tmp = await retrievePublishedPackagesByUserName({
    userName,
    currency,
  });
  const items = Promise.all(
    tmp
      .map(async (pkg) => {
        const url = pkg.iconFile && contentPath(pkg.iconFile.id);

        return {
          id: pkg.id,
          name: pkg.name,
          displayName: pkg.displayName || undefined,
          shortDescription: pkg.shortDescription,
          userName: pkg.user.Profile?.userName || undefined,
          iconFileUrl: url || undefined,
          tags: pkg.tags,
          price: selectPricing(pkg.packagePricing, currency),
        };
      }),
  );

  return {
    items: await items,
    displayName: (await profile)?.displayName || userName,
  };
}

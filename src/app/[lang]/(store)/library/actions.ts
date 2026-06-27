import "server-only";
import { contentPath } from "@/lib/content-url";
import { guessCurrency } from "@/lib/currency";
import { retrieveLibraryPackagesByUserId } from "@/lib/db/user-package";
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

export async function retrievePackages(
  userId: string,
): Promise<ListedPackage[]> {
  const currency = await guessCurrency();
  const tmp = await retrieveLibraryPackagesByUserId({
    userId,
    currency,
  });

  return await Promise.all(
    tmp
      .map((up) => up.package)
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
}

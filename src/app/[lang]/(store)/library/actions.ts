import "server-only";
import { drizzle } from "@/drizzle";
import { guessCurrency } from "@/lib/currency";
import { userPackage, packages, file, user, profile, packagePricing } from "@/drizzle/schema";
import { eq, and, or } from "drizzle-orm";

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
  const db = await drizzle();
  
  const results = await db
    .select({
      id: packages.id,
      displayName: packages.displayName,
      name: packages.name,
      shortDescription: packages.shortDescription,
      tags: packages.tags,
      iconFileId: file.id,
      userName: profile.userName,
      pricingPrice: packagePricing.price,
      pricingCurrency: packagePricing.currency,
      pricingFallback: packagePricing.fallback,
    })
    .from(userPackage)
    .innerJoin(packages, eq(userPackage.packageId, packages.id))
    .leftJoin(file, eq(packages.iconFileId, file.id))
    .leftJoin(user, eq(packages.userId, user.id))
    .leftJoin(profile, eq(user.id, profile.userId))
    .leftJoin(packagePricing, eq(packages.id, packagePricing.packageId))
    .where(
      and(
        eq(userPackage.userId, userId),
        eq(packages.published, true),
        or(
          eq(packagePricing.currency, currency),
          eq(packagePricing.fallback, true)
        )
      )
    );

  // Group results by package ID to handle multiple pricing records
  const groupedResults = results.reduce((acc, row) => {
    if (!acc[row.id]) {
      acc[row.id] = {
        ...row,
        pricing: []
      };
    }
    if (row.pricingPrice !== null && row.pricingCurrency !== null) {
      acc[row.id].pricing.push({
        price: row.pricingPrice,
        currency: row.pricingCurrency,
        fallback: row.pricingFallback
      });
    }
    return acc;
  }, {} as Record<string, any>);

  return Object.values(groupedResults).map((pkg: any) => {
    const url = pkg.iconFileId && `/api/contents/${pkg.iconFileId}`;
    const selectedPrice = 
      pkg.pricing.find((p: any) => p.currency === currency) ||
      pkg.pricing.find((p: any) => p.fallback) ||
      pkg.pricing[0];

    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName || undefined,
      shortDescription: pkg.shortDescription,
      userName: pkg.userName || undefined,
      iconFileUrl: url || undefined,
      tags: pkg.tags || [],
      price: selectedPrice,
    };
  });
}

import "server-only";
import { drizzle } from "@/drizzle";
import { guessCurrency } from "@/lib/currency";
import { packages, file, user, profile, packagePricing } from "@/drizzle/schema";
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

export async function retrievePublishedPackages(
  userName: string,
): Promise<{ items: ListedPackage[]; displayName: string }> {
  const currency = await guessCurrency();
  const db = await drizzle();
  
  const profileResult = await db
    .select({
      displayName: profile.displayName,
    })
    .from(profile)
    .where(eq(profile.userName, userName))
    .limit(1);

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
    .from(packages)
    .innerJoin(user, eq(packages.userId, user.id))
    .innerJoin(profile, eq(user.id, profile.userId))
    .leftJoin(file, eq(packages.iconFileId, file.id))
    .leftJoin(packagePricing, eq(packages.id, packagePricing.packageId))
    .where(
      and(
        eq(profile.userName, userName),
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
  const items = Object.values(groupedResults).map((pkg: any) => {
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

  return {
    items,
    displayName: profileResult[0]?.displayName || userName,
  };
}

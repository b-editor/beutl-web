type OwnedPublication = {
  userId: string;
  published: boolean;
};

export type ContentAccessFile = {
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  userId: string;
  Package: readonly OwnedPublication[];
  Profile: readonly unknown[];
  PackageScreenshot: readonly {
    package: OwnedPublication;
  }[];
  Release: readonly {
    published: boolean;
    package: OwnedPublication & {
      id: string;
      packagePricing: readonly { id: string; price: number }[];
    };
  }[];
};

export type ContentAccessResult =
  | { outcome: "allowed"; canUsePublicCache: boolean }
  | { outcome: "denied" }
  | { outcome: "payment-required" };

export async function resolveContentAccess({
  file,
  userId,
  hasPurchasedPackage,
}: {
  file: ContentAccessFile;
  userId: string | null;
  hasPurchasedPackage: (packageId: string) => Promise<boolean>;
}): Promise<ContentAccessResult> {
  const isReleasePayload = file.Release.length > 0;

  if (file.visibility === "PUBLIC") {
    return { outcome: "allowed", canUsePublicCache: !isReleasePayload };
  }
  if (file.visibility === "PRIVATE") {
    return file.userId === userId
      ? { outcome: "allowed", canUsePublicCache: false }
      : { outcome: "denied" };
  }

  const packageIsPublic = file.Package.some((pkg) => pkg.published);
  const packageIsOwned = file.Package.some((pkg) => pkg.userId === userId);
  const screenshotIsPublic = file.PackageScreenshot.some(
    (screenshot) => screenshot.package.published,
  );
  const screenshotIsOwned = file.PackageScreenshot.some(
    (screenshot) => screenshot.package.userId === userId,
  );
  const profileIsPublic = file.Profile.length > 0;

  const visibleReleases = file.Release.filter(
    (release) =>
      (release.published && release.package.published) ||
      release.package.userId === userId,
  );
  const releaseIsOwned = visibleReleases.some(
    (release) => release.package.userId === userId,
  );
  const freeReleaseAllowsAnonymousAccess = visibleReleases.some(
    (release) =>
      release.published &&
      release.package.published &&
      !release.package.packagePricing.some((pricing) => pricing.price > 0),
  );

  const allowsAnonymousAccess =
    packageIsPublic ||
    screenshotIsPublic ||
    profileIsPublic ||
    freeReleaseAllowsAnonymousAccess;
  if (allowsAnonymousAccess) {
    return {
      outcome: "allowed",
      canUsePublicCache: !isReleasePayload,
    };
  }
  if (
    file.userId === userId ||
    packageIsOwned ||
    screenshotIsOwned ||
    releaseIsOwned
  ) {
    return { outcome: "allowed", canUsePublicCache: false };
  }

  const paidPackageIds = [
    ...new Set(
      visibleReleases
        .filter((release) =>
          release.package.packagePricing.some((pricing) => pricing.price > 0),
        )
        .map((release) => release.package.id),
    ),
  ];
  if (paidPackageIds.length === 0) {
    return { outcome: "denied" };
  }
  if (!userId) {
    return { outcome: "payment-required" };
  }

  const paymentRecords = await Promise.all(
    paidPackageIds.map((packageId) => hasPurchasedPackage(packageId)),
  );
  return paymentRecords.some(Boolean)
    ? { outcome: "allowed", canUsePublicCache: false }
    : { outcome: "payment-required" };
}

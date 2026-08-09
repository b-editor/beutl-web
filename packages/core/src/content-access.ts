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
      packagePricing: readonly { id: string }[];
    };
  }[];
};

export type ContentAccessResult =
  | { outcome: "allowed"; isPublic: boolean }
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
  if (file.visibility === "PUBLIC") {
    return { outcome: "allowed", isPublic: true };
  }
  if (file.visibility === "PRIVATE") {
    return file.userId === userId
      ? { outcome: "allowed", isPublic: false }
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
  const freeReleaseIsPublic = visibleReleases.some(
    (release) =>
      release.published &&
      release.package.published &&
      release.package.packagePricing.length === 0,
  );

  const isPublic =
    packageIsPublic ||
    screenshotIsPublic ||
    profileIsPublic ||
    freeReleaseIsPublic;
  if (isPublic) {
    return { outcome: "allowed", isPublic: true };
  }
  if (packageIsOwned || screenshotIsOwned || releaseIsOwned) {
    return { outcome: "allowed", isPublic: false };
  }

  const paidPackageIds = [
    ...new Set(
      visibleReleases
        .filter((release) => release.package.packagePricing.length > 0)
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
    ? { outcome: "allowed", isPublic: false }
    : { outcome: "payment-required" };
}

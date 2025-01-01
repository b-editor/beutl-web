"use server"

import { auth } from "@/auth";
import { retrieveDevPackagesByUserId } from "@/lib/db/package";
import { SemVer } from "semver";

export type Package = {
  id: string;
  name: string;
  displayName?: string;
  iconFileUrl?: string;
  latestVersion?: string;
  published: boolean;
};

export async function retrievePackages(): Promise<Package[]> {
  const session = await auth();
  if (!session?.user?.id) {
    return [];
  }
  const packages = await retrieveDevPackagesByUserId({ userId: session.user.id });

  return await Promise.all(packages.map(async (pkg) => {
    pkg.Release.sort((a, b) => {
      return new SemVer(a.version).compare(b.version);
    });
    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName || undefined,
      iconFileUrl: pkg.iconFile && `/api/contents/${pkg.iconFile.id}` || undefined,
      latestVersion: pkg.Release[0]?.version,
      published: pkg.published
    };
  }));
}
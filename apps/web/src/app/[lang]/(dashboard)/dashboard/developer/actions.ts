"use server";

import { auth } from "@/lib/better-auth";
import { retrieveDevPackagesByUserId } from "@beutl/db";
import { headers } from "next/headers";
import { toPackages, type Package } from "./packages";

export async function retrievePackages(): Promise<Package[]> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return [];
  }
  const packages = await retrieveDevPackagesByUserId({
    userId: session.user.id,
  });
  if (!packages) {
    return [];
  }

  return toPackages(packages);
}

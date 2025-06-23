"use server";

import { getTranslation } from "@/app/i18n/server";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authenticated } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { drizzle } from "@/drizzle";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { packages, userPackage } from "@/drizzle/schema";
import { eq, and } from "drizzle-orm";

export async function addToLibrary(packageId: string) {
  const lang = await getLanguage();
  const db = await drizzle();
  const result = await db
    .select({ name: packages.name })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  
  if (!result[0]) {
    throw new Error("Package not found");
  }
  const { name } = result[0];
  redirect(`/${lang}/store/${name}/get`);
}

export async function removeFromLibrary(packageId: string) {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const db = await drizzle();
    
    // First get the package name
    const packageResult = await db
      .select({ name: packages.name })
      .from(userPackage)
      .innerJoin(packages, eq(userPackage.packageId, packages.id))
      .where(
        and(
          eq(userPackage.userId, session.user.id),
          eq(userPackage.packageId, packageId)
        )
      )
      .limit(1);
    
    if (!packageResult[0]) {
      throw new Error("Package not found in library");
    }
    
    const { name } = packageResult[0];
    
    // Then delete the userPackage record
    await db
      .delete(userPackage)
      .where(
        and(
          eq(userPackage.userId, session.user.id),
          eq(userPackage.packageId, packageId)
        )
      );
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.store.removeFromLibrary,
      details: `packageId: ${packageId}`,
    });
    revalidatePath(`/store/${name}`);
    return {
      success: true,
      message: t("store:removedFromLibrary"),
    };
  });
}

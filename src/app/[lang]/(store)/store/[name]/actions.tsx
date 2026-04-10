"use server";

import { getTranslation } from "@/app/i18n/server";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authenticated, authOrSignIn } from "@/lib/auth-guard";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { getLanguage } from "@/lib/lang-utils";
import { getDbAsync } from "@/db";
import { packageTable, userPackage } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addToLibrary(packageId: string) {
  const session = await authOrSignIn();
  const lang = await getLanguage();
  const db = await getDbAsync();

  const pkg = await db.query.packageTable.findFirst({
    where: and(eq(packageTable.id, packageId), eq(packageTable.published, true)),
    columns: {
      id: true,
      name: true,
    },
    with: {
      packagePricings: {
        columns: {
          id: true,
        },
      },
    },
  });
  if (!pkg) {
    return { success: false, message: "Package not found" };
  }

  if (pkg.packagePricings.length > 0) {
    // すでに支払いをしている場合のみ、支払わずにuserPackageを作成する
    const record = await existsUserPaymentHistory({
      userId: session.user.id,
      packageId: pkg.id,
    });
    if (!record) {
      redirect(`/${lang}/store/${pkg.name}/checkout`);
    }
  }

  const existing = await db
    .select({ userId: userPackage.userId })
    .from(userPackage)
    .where(
      and(
        eq(userPackage.userId, session.user.id),
        eq(userPackage.packageId, pkg.id),
      ),
    )
    .limit(1);
  if (!existing[0]) {
    await db.insert(userPackage).values({
      userId: session.user.id,
      packageId: pkg.id,
    });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.store.addToLibrary,
      details: `packageId: ${pkg.id}`,
    });
  }

  revalidatePath(`/${lang}/store/${pkg.name}`);
  redirect(`/${lang}/store/${pkg.name}?message=PleaseOpenDesktopApp`);
}

export async function removeFromLibrary(packageId: string) {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const db = await getDbAsync();

    // First get the package name
    const pkg = await db.query.packageTable.findFirst({
      where: eq(packageTable.id, packageId),
      columns: { name: true },
    });

    // Delete the user package entry
    await db
      .delete(userPackage)
      .where(
        and(
          eq(userPackage.userId, session.user.id),
          eq(userPackage.packageId, packageId),
        ),
      );

    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.store.removeFromLibrary,
      details: `packageId: ${packageId}`,
    });
    revalidatePath(`/${lang}/store/${pkg?.name}`);
    return {
      success: true,
      message: t("store:removedFromLibrary"),
    };
  });
}

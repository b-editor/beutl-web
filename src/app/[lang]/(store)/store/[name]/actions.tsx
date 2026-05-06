"use server";

import { getTranslation } from "@/app/i18n/server";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authenticated, authOrSignIn } from "@/lib/auth-guard";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { getLanguage } from "@/lib/lang-utils";
import { getDbAsync } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addToLibrary(packageId: string) {
  const session = await authOrSignIn();
  const lang = await getLanguage();
  const db = await getDbAsync();

  const pkg = await db.package.findFirst({
    where: {
      id: packageId,
      published: true,
    },
    select: {
      id: true,
      name: true,
      packagePricing: true,
    },
  });
  if (!pkg) {
    return { success: false, message: "Package not found" };
  }

  if (pkg.packagePricing.length > 0) {
    // すでに支払いをしている場合のみ、支払わずにuserPackageを作成する
    const record = await existsUserPaymentHistory({
      userId: session.user.id,
      packageId: pkg.id,
    });
    if (!record) {
      redirect(`/${lang}/store/${pkg.name}/checkout`);
    }
  }

  if (
    !(await db.userPackage.findFirst({
      where: { userId: session.user.id, packageId: pkg.id },
    }))
  ) {
    await db.userPackage.create({
      data: {
        userId: session.user.id,
        packageId: pkg.id,
      },
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
    const {
      package: { name },
    } = await db.userPackage.delete({
      where: {
        userId_packageId: {
          userId: session.user.id,
          packageId,
        },
      },
      select: {
        package: {
          select: {
            name: true,
          },
        },
      },
    });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.store.removeFromLibrary,
      details: `packageId: ${packageId}`,
    });
    revalidatePath(`/${lang}/store/${name}`);
    return {
      success: true,
      message: t("store:removedFromLibrary"),
    };
  });
}

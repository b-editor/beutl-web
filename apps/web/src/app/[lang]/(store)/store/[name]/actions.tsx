"use server";

import { getTranslation } from "@/app/i18n/server";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authenticated } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getDbAsync } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addToLibrary(packageId: string) {
  const lang = await getLanguage();
  const db = await getDbAsync();
  const { name } = await db.package.findFirstOrThrow({
    where: {
      id: packageId,
    },
    select: {
      name: true,
    },
  });
  redirect(`/${lang}/store/${name}/get`);
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
    revalidatePath(`/store/${name}`);
    return {
      success: true,
      message: t("store:removedFromLibrary"),
    };
  });
}

"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import {
  createDevPackageScreenshot,
  deleteDevPackageScreenshotAndFile,
  getPackageNameFromPackageId,
  reorderDevPackageScreenshots,
  retrieveDevPackageLastScreenshotOrder,
  retrieveDevPackageScreenshots,
} from "@beutl/db";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import { createDedicatedFile, sameUser } from "./_shared";

export async function addScreenshot(formData: FormData): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const file = formData.get("file") as File;
    if (!file) {
      return {
        success: false,
        message: t("developer:errors.fileNotFound"),
      };
    }
    const id = formData.get("id") as string;
    return await sameUser(id, session.user.id, t, async () => {
      const name = await getPackageNameFromPackageId({ packageId: id });
      const result = await createDedicatedFile(
        session.user.id,
        file,
        t,
        async (tx, record) => {
          const existing = await tx.packageScreenshot.findUnique({
            where: { packageId_fileId: { packageId: id, fileId: record.id } },
          });
          if (existing) return;
          // Serialize max(order)+1 allocation on the Package row. Cockroach turns concurrent
          // writers into a retryable transaction conflict before the unique order can diverge.
          await tx.package.update({
            where: { id },
            data: { updatedAt: new Date() },
          });
          const lastScreenshot = await retrieveDevPackageLastScreenshotOrder({ packageId: id, prisma: tx });
          await createDevPackageScreenshot({
            packageId: id,
            fileId: record.id,
            order: (lastScreenshot?.order ?? -1) + 1,
            prisma: tx,
          });
        },
      );
      if (!result.success) {
        return result;
      }
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function moveScreenshot({
  delta,
  packageId,
  fileId,
}: { delta: number; packageId: string; fileId: string }): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(packageId, session.user.id, t, async () => {
      const name = await getPackageNameFromPackageId({ packageId });
      const sign = Math.sign(delta);
      const all = await retrieveDevPackageScreenshots({ packageId });

      const target = all.find((screenshot) => screenshot.fileId === fileId);
      if (!target) {
        return {
          success: false,
          message: t("developer:errors.fileNotFound"),
        };
      }

      const index = all.indexOf(target);
      if (index === 0 && sign < 0) {
        return {
          success: false,
          message: t("developer:screenshots.alreadyFirst"),
        };
      }
      if (index === all.length - 1 && sign > 0) {
        return {
          success: false,
          message: t("developer:screenshots.alreadyLast"),
        };
      }
      all.splice(index, 1);
      all.splice(index + sign, 0, target);
      await reorderDevPackageScreenshots({
        packageId,
        orderedFileIds: all.map((item) => item.fileId),
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function deleteScreenshot({
  packageId,
  fileId,
}: { packageId: string; fileId: string }): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(packageId, session.user.id, t, async () => {
      const name = await getPackageNameFromPackageId({ packageId });
      await deleteDevPackageScreenshotAndFile({ packageId, fileId });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

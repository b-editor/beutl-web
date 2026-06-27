"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@/lib/action-result";
import { authenticated } from "@/lib/auth-guard";
import {
  createDevPackageScreenshot,
  deleteDevPackageScreenshot,
  getPackageNameFromPackageId,
  retrieveDevPackageLastScreenshotOrder,
  retrieveDevPackageScreenshots,
  updateDevPackageScreenshotOrder,
} from "@/lib/db/package";
import {
  deleteStorageFile,
} from "@/lib/storage";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
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
        BigInt(0),
        t,
      );
      if (!result.success) {
        return result;
      }
      const lastScreenshot = await retrieveDevPackageLastScreenshotOrder({
        packageId: id,
      });
      await createDevPackageScreenshot({
        packageId: id,
        fileId: result.record!.id,
        order: (lastScreenshot?.order || 0) + 1,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/${lang}/developer/projects/${name}`);
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
      const promises = all
        .map((item, i) => ({
          ...item,
          order: i,
          originalOrder: item.order,
        }))
        .map(async (item) => {
          if (item.order === item.originalOrder) return;
          await updateDevPackageScreenshotOrder({
            packageId,
            fileId: item.fileId,
            order: item.order,
          });
        });
      await Promise.all(promises);
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/${lang}/developer/projects/${name}`);
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
      await deleteDevPackageScreenshot({ packageId, fileId });
      await deleteStorageFile({ fileId });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

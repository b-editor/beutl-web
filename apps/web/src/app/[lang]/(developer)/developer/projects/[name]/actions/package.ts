"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { contentPath } from "@/lib/content-url";
import {
  deleteDevPackage,
  getPackagePublishedByIdOrThrow,
  PackageFileConflictError,
  retrieveDevPackageByName,
  retrieveDevPackageIconFile,
  updateDevPackageDescription,
  updateDevPackageDisplay,
  updateDevPackageIconFile,
  updateDevPackagePublished,
  updateDevPackageTags,
} from "@beutl/db";
import {
  abandonPendingStorageFile,
  drainStorageCleanup,
} from "@/lib/storage";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import SemVer from "semver";
import {
  createDedicatedFile,
  displayNameAndShortDescriptionSchema,
  sameUser,
} from "./_shared";
import type { State } from "./_shared";

export async function updateDisplayNameAndShortDescription(
  state: State,
  formData: FormData,
): Promise<State> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const validated = displayNameAndShortDescriptionSchema(t).safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: t("developer:errors.invalidInput"),
        success: false,
      };
    }

    const { displayName, shortDescription, id } = validated.data;
    return await sameUser(id, session.user.id, t, async () => {
      const { name } = await updateDevPackageDisplay({
        packageId: id,
        displayName,
        shortDescription,
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

export async function updateDescription({
  packageId,
  description,
}: { packageId: string; description: string }): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    if (description.length > 1000) {
      return {
        message: t("developer:validation.descriptionMax"),
        success: false,
      };
    }

    return await sameUser(packageId, session.user.id, t, async () => {
      const { name } = await updateDevPackageDescription({
        packageId,
        description,
      });
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

export async function retrievePackage(name: string) {
  const session = await throwIfUnauth();
  const pkg = await retrieveDevPackageByName({ name, userId: session.user.id });
  if (!pkg) {
    return null;
  }
  pkg.Release.sort((a, b) => {
    return new SemVer.SemVer(b.version).compare(a.version);
  });
  const screenshots = await Promise.all(
    pkg.PackageScreenshot.map(async (item) => {
      return {
        ...item,
        url: contentPath(item.file.id),
      };
    }),
  );

  return {
    ...pkg,
    iconFileUrl: pkg.iconFile && contentPath(pkg.iconFile.id),
    PackageScreenshot: screenshots,
  };
}

export async function deletePackage(id: string): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(id, session.user.id, t, async () => {
      await deleteDevPackage({ packageId: id });
      await drainStorageCleanup();
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deletePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/${lang}/developer`);
      redirect(`/${lang}/developer`);
    });
  });
}

export async function changePackageVisibility(
  id: string,
  published: boolean,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(id, session.user.id, t, async () => {
      const { published: oldPublished } = await getPackagePublishedByIdOrThrow({
        id,
      });
      const { name } = await updateDevPackagePublished({
        packageId: id,
        published,
      });
      if (oldPublished !== published) {
        await addAuditLog({
          userId: session.user.id,
          action: published
            ? auditLogActions.developer.publishPackage
            : auditLogActions.developer.unpublishPackage,
          details: `packageId: ${id}`,
        });
      }
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function uploadIcon(formData: FormData): Promise<ActionResult> {
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
      const iconFile = await retrieveDevPackageIconFile({ packageId: id });

      const deletedSize = iconFile ? BigInt(iconFile.size) : BigInt(0);
      const result = await createDedicatedFile(
        session.user.id,
        file,
        deletedSize,
        t,
      );
      if (!result.success) {
        return {
          success: result.success,
          message: result.message,
        };
      }

      if (!result.record) {
        throw new Error("The uploaded icon file record is missing.");
      }
      let name: string;
      try {
        ({ name } = await updateDevPackageIconFile({
          packageId: id,
          fileId: result.record.id,
          expectedFileId: iconFile?.id ?? null,
        }));
      } catch (error) {
        await abandonPendingStorageFile({ fileId: result.record.id });
        if (error instanceof PackageFileConflictError) {
          return {
            success: false,
            message: t("developer:errors.fileConflict"),
          };
        }
        throw error;
      }
      await drainStorageCleanup();
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

export async function updateTag({
  packageId,
  tags,
}: { packageId: string; tags: string[] }): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(packageId, session.user.id, t, async () => {
      const { name } = await updateDevPackageTags({
        packageId,
        tags,
      });
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

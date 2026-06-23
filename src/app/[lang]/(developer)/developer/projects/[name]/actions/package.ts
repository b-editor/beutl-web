"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@/lib/action-result";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { contentPath } from "@/lib/content-url";
import {
  deleteDevPackage,
  getPackagePublishedByIdOrThrow,
  retrieveDevPackageByName,
  retrieveDevPackageDependsFile,
  retrieveDevPackageIconFile,
  updateDevPackageDescription,
  updateDevPackageDisplay,
  updateDevPackageIconFile,
  updateDevPackagePublished,
  updateDevPackageTags,
} from "@/lib/db/package";
import {
  deleteStorageFile,
} from "@/lib/storage";
import { getLanguage } from "@/lib/lang-utils";
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
    const validated = displayNameAndShortDescriptionSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: "入力内容に誤りがあります",
        success: false,
      };
    }

    const { displayName, shortDescription, id } = validated.data;
    return await sameUser(id, session.user.id, async () => {
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
      const lang = await getLanguage();
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
    if (description.length > 1000) {
      return {
        message: "説明は1000文字以下である必要があります",
        success: false,
      };
    }

    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await updateDevPackageDescription({
        packageId,
        description,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      const lang = await getLanguage();
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
    return await sameUser(id, session.user.id, async () => {
      const files = await retrieveDevPackageDependsFile({ packageId: id });
      await deleteDevPackage({ packageId: id });
      const promises = files.map(async (file) => {
        await deleteStorageFile({
          fileId: file.id,
        });
      });

      await Promise.all(promises);
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deletePackage,
        details: `packageId: ${id}`,
      });
      const lang = await getLanguage();
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
    return await sameUser(id, session.user.id, async () => {
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
      const lang = await getLanguage();
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function uploadIcon(formData: FormData): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const file = formData.get("file") as File;
    if (!file) {
      return {
        success: false,
        message: "ファイルが見つかりません",
      };
    }
    const id = formData.get("id") as string;
    return await sameUser(id, session.user.id, async () => {
      const iconFile = await retrieveDevPackageIconFile({ packageId: id });

      const deletedSize = iconFile ? BigInt(iconFile.size) : BigInt(0);
      const result = await createDedicatedFile(
        session.user.id,
        file,
        deletedSize,
      );
      if (!result.success) {
        return {
          success: result.success,
          message: result.message,
        };
      }

      if (iconFile) {
        await deleteStorageFile({
          fileId: iconFile.id,
        });
      }

      const { name } = await updateDevPackageIconFile({
        packageId: id,
        fileId: result.record!.id,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${id}`,
      });
      const lang = await getLanguage();
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
    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await updateDevPackageTags({
        packageId,
        tags,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      const lang = await getLanguage();
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

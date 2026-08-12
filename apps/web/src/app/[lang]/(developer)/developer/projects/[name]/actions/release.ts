"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { applyPackageType, getPackageType } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import { buildDataPackageNupkgFile } from "@/lib/data-package";
import {
  getPackageNameFromPackageId,
  getProfileByUserId,
  retrieveDevPackageByName,
  updateDevPackageTags,
} from "@beutl/db";
import {
  createRelease as createReleaseRecord,
  deleteReleaseById,
  getReleasePackageAndFileId,
  getReleasePublishedByIdOrThrow,
  getReleaseWithFileById,
  updateRelease as updateReleaseRecord,
} from "@beutl/db";
import {
  deleteStorageFile,
} from "@/lib/storage";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import SemVer from "semver";
import {
  createDedicatedFile,
  releaseSchema,
  sameUser,
} from "./_shared";
import type { ReleaseRecord } from "./_shared";

export async function updateRelease(
  formData: FormData,
): Promise<ActionResult<ReleaseRecord>> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const validated = releaseSchema(t).safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: t("developer:errors.invalidInput"),
        success: false,
      };
    }
    const release = await getReleaseWithFileById({
      id: validated.data.id,
    });
    if (!release?.packageId) {
      return {
        success: false,
        message: t("developer:errors.idNotFound"),
      };
    }

    return await sameUser(release.packageId, session.user.id, t, async () => {
      let fileId = release.file?.id;
      let tags: string[] | undefined;

      const packageName = await getPackageNameFromPackageId({
        packageId: release.packageId,
      });
      if (!packageName) {
        return { success: false, message: t("developer:errors.idNotFound") };
      }
      const devPackage = await retrieveDevPackageByName({
        name: packageName,
        userId: session.user.id,
      });
      const currentTags = devPackage?.tags ?? [];

      const uploaded = formData.getAll("file") as File[];
      const singleNupkg =
        uploaded.length === 1 && uploaded[0].name.toLowerCase().endsWith(".nupkg");

      if (singleNupkg) {
        // A lone .nupkg is an extension release; drop any data markers a previous
        // upload may have left so the store stops classifying it as a data package.
        tags = applyPackageType(currentTags, "extension");

        const deletedSize = release.file
          ? BigInt(release.file.size)
          : BigInt(0);
        const result = await createDedicatedFile(
          session.user.id,
          uploaded[0],
          deletedSize,
          t,
        );
        if (!result.success) {
          return {
            success: result.success,
            message: result.message,
          };
        }

        if (release.file) {
          await deleteStorageFile({
            fileId: release.file.id,
          });
        }
        fileId = result.record!.id;
      } else if (uploaded.length > 0) {
        const profile = await getProfileByUserId(session.user.id);
        const username = profile?.userName || session.user.name || session.user.id;

        const built = await buildDataPackageNupkgFile({
          files: uploaded,
          id: packageName,
          version: release.version,
          title: validated.data.title,
          description: validated.data.description,
          username,
          t,
        });
        if (!built.ok) {
          return { success: false, message: built.message };
        }

        // Keep the author's visible tags; only the kind markers change.
        tags = applyPackageType(currentTags, getPackageType(built.tags));

        const deletedSize = release.file ? BigInt(release.file.size) : BigInt(0);
        const result = await createDedicatedFile(
          session.user.id,
          built.file,
          deletedSize,
          t,
        );
        if (!result.success) {
          return { success: false, message: result.message };
        }

        if (release.file) {
          await deleteStorageFile({ fileId: release.file.id });
        }
        fileId = result.record!.id;
      }

      if (tags) {
        await updateDevPackageTags({ packageId: release.packageId, tags });
      }

      const { published: oldPublished } = await getReleasePublishedByIdOrThrow({
        id: validated.data.id,
      });
      const data = await updateReleaseRecord({
        id: validated.data.id,
        title: validated.data.title,
        description: validated.data.description,
        targetVersion: validated.data.targetVersion,
        published: validated.data.published === "on",
        fileId: fileId,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updateRelease,
        details: `releaseId: ${data.id}`,
      });
      if (oldPublished !== data.published) {
        await addAuditLog({
          userId: session.user.id,
          action: data.published
            ? auditLogActions.developer.publishRelease
            : auditLogActions.developer.unpublishRelease,
          details: `releaseId: ${data.id}`,
        });
      }

      const name = await getPackageNameFromPackageId({ packageId: release.packageId });
      revalidatePath(`/${lang}/developer/projects/${name}`);

      return {
        success: true,
        data,
      };
    });
  });
}

export async function createRelease({
  packageId,
  version,
}: {
  packageId: string;
  version: string;
}): Promise<ActionResult<ReleaseRecord>> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(packageId, session.user.id, t, async () => {
      if (SemVer.valid(version) === null) {
        return {
          success: false,
          message: t("developer:validation.versionInvalid"),
        };
      }

      const release = await createReleaseRecord({
        packageId,
        version,
        title: t("developer:release.defaultTitle"),
        description: "",
        targetVersion: "1.0.0-preview.10",
        published: false,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.createRelease,
        details: `packageId: ${packageId}, releaseId: ${release.id}, version: ${version}`,
      });
      const name = await getPackageNameFromPackageId({ packageId });
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return {
        success: true,
        data: release,
      };
    });
  });
}

export async function deleteRelease({
  releaseId,
}: { releaseId: string }): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const release = await getReleasePackageAndFileId({
      id: releaseId,
    });
    if (!release?.packageId) {
      return {
        success: false,
        message: t("developer:errors.idNotFound"),
      };
    }
    return await sameUser(release.packageId, session.user.id, t, async () => {
      if (release.fileId) {
        await deleteStorageFile({
          fileId: release.fileId,
        });
      }
      await deleteReleaseById({
        id: releaseId,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deleteRelease,
        details: `releaseId: ${releaseId}`,
      });
      const name = await getPackageNameFromPackageId({
        packageId: release.packageId,
      });
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

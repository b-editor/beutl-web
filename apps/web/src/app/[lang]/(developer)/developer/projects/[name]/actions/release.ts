"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult, PackageType } from "@beutl/core";
import { applyPackageType, getPackageType } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import { buildDataPackageNupkgFile } from "@/lib/data-package";
import {
  getPackageNameFromPackageId,
  getProfileByUserId,
  retrieveDevPackageByName,
  startTransaction,
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
      // Only the kind is decided here; it is merged into the package's visible tags
      // inside the write transaction, so a tag edit landing meanwhile is not discarded.
      let packageType: PackageType | undefined;
      // Deleting the old artifact clears the release's file relation, so it waits until
      // the replacement is committed — a failure in between would leave a published
      // release with nothing to download. Which file that is can only be read inside the
      // transaction: a concurrent save may have replaced it since this request started.
      let replacesArtifact = false;
      let replacedFileId: string | undefined;
      // Tracked so a failed release transaction does not strand the upload against
      // the publisher's quota.
      let uploadedFileId: string | undefined;

      const packageName = await getPackageNameFromPackageId({
        packageId: release.packageId,
      });
      if (!packageName) {
        return { success: false, message: t("developer:errors.idNotFound") };
      }

      // Read before the upload: a failure here would otherwise strand the file the
      // cleanup below only covers once the transaction is reached.
      const { published: oldPublished } = await getReleasePublishedByIdOrThrow({
        id: validated.data.id,
      });

      const uploaded = formData.getAll("file") as File[];
      const singleNupkg =
        uploaded.length === 1 && uploaded[0].name.toLowerCase().endsWith(".nupkg");

      if (singleNupkg) {
        // A lone .nupkg is an extension release; drop any data markers a previous
        // upload may have left so the store stops classifying it as a data package.
        packageType = "extension";

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

        replacesArtifact = true;
        fileId = result.record!.id;
        uploadedFileId = result.record!.id;
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

        packageType = getPackageType(built.tags);

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

        replacesArtifact = true;
        fileId = result.record!.id;
        uploadedFileId = result.record!.id;
      }

      // The tags describe the artifact the release points at, so either both writes land
      // or neither does — a partial commit leaves the store classifying the package from
      // an artifact the release does not serve.
      let data: ReleaseRecord;
      try {
        data = await startTransaction(async (tx) => {
          if (replacesArtifact) {
            // A concurrent save may have replaced the artifact since this request read
            // it, and the file this one actually displaces is the one to clean up.
            const current = await getReleaseWithFileById({
              id: validated.data.id,
              prisma: tx,
            });
            replacedFileId = current?.file?.id;
          }

          const updated = await updateReleaseRecord({
            id: validated.data.id,
            title: validated.data.title,
            description: validated.data.description,
            targetVersion: validated.data.targetVersion,
            published: validated.data.published === "on",
            fileId: fileId,
            prisma: tx,
          });

          if (packageType) {
            // Read the visible tags here rather than before the upload, so a tag edit
            // that landed while the archive was being built is not discarded.
            const devPackage = await retrieveDevPackageByName({
              name: packageName,
              userId: session.user.id,
              prisma: tx,
            });
            await updateDevPackageTags({
              packageId: release.packageId,
              tags: applyPackageType(devPackage?.tags ?? [], packageType),
              prisma: tx,
            });
          }

          return updated;
        });
      } catch (error) {
        // Nothing references the upload now, and it would still count against the
        // publisher's quota, so every retry would cost them another copy.
        if (uploadedFileId) {
          try {
            await deleteStorageFile({ fileId: uploadedFileId });
          } catch (cleanupError) {
            console.error(
              `Failed to delete the orphaned upload ${uploadedFileId}:`,
              cleanupError,
            );
          }
        }
        throw error;
      }

      if (replacedFileId) {
        // The release already points at the new artifact, so a failure here must not
        // report the save as failed — a retry would upload another copy while the
        // orphaned file keeps consuming the publisher's quota either way.
        try {
          await deleteStorageFile({ fileId: replacedFileId });
        } catch (error) {
          console.error(
            `Failed to delete the replaced artifact ${replacedFileId}:`,
            error,
          );
        }
      }

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

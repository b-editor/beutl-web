"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { applyPackageType, isValidNugetVersion, type ActionResult } from "@beutl/core";
import { InvalidNugetPackageError, readNugetPackage, storedPackageReader } from "@beutl/api/nuget/archive";
import { refreshNugetPackageMetadata, ReleaseArtifactLockedError, ReleaseIdentityConflictError } from "@beutl/db";
import { authenticated } from "@/lib/auth-guard";
import {
  getPackageNameFromPackageId,
  retrieveDevPackageByName,
  startTransaction,
  deleteUnreferencedFileWithStorageCleanup,
  updateDevPackageTags,
} from "@beutl/db";
import type { PrismaTransaction } from "@beutl/db";
import {
  createRelease as createReleaseRecord,
  deleteReleaseWithStorageCleanup,
  getReleasePackageAndFileId,
  getReleasePublishedByIdOrThrow,
  getReleaseWithFileById,
  updateRelease as updateReleaseRecord,
  upsertReleaseTranslations,
} from "@beutl/db";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import { prepareReleaseArtifact } from "./release-artifact";
import {
  createDedicatedFile,
  releaseSchema,
  sameUser,
} from "./_shared";
import type { ReleaseRecord } from "./_shared";

class ReleaseFileRequiredError extends Error {}

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
      const uploaded = formData.getAll("file").filter((f): f is File => typeof f !== "string" && f.size > 0);
      if (uploaded.length && (release.artifactLocked || release.published)) {
        return { success: false, message: t("developer:release.artifactLocked") };
      }
      if (release.package.audience === "USER" && !validated.data.targetVersion) {
        return { success: false, message: t("developer:validation.versionInvalid") };
      }
      try {
        const packageName = await getPackageNameFromPackageId({
          packageId: release.packageId,
        });
        if (!packageName) {
          return { success: false, message: t("developer:errors.idNotFound") };
        }

        // Audit the visibility transition separately; publication rechecks ownership
        // in the File transaction before changing the release.
        const { published: oldPublished } = await getReleasePublishedByIdOrThrow({
          id: validated.data.id,
        });

        const prepared = uploaded.length > 0 ? await prepareReleaseArtifact({
          files: uploaded,
          audience: release.package.audience,
          id: packageName,
          version: release.version,
          title: validated.data.title,
          description: validated.data.description,
          user: session.user,
          t,
        }) : undefined;
        if (prepared && !prepared.ok) return { success: false, message: prepared.message };
        const artifact = prepared?.artifact;

        const publishRelease = async (
          tx: PrismaTransaction,
          replacementFileId?: string,
        ): Promise<ReleaseRecord> => {
          const current = await getReleaseWithFileById({
            id: validated.data.id,
            prisma: tx,
          });
          const devPackage = await retrieveDevPackageByName({
            name: packageName,
            userId: session.user.id,
            prisma: tx,
          });
          if (!current || current.packageId !== release.packageId || !devPackage) {
            throw new Error("Release ownership changed before publication");
          }
          const fileId = replacementFileId ?? current.file?.id;
          if (validated.data.published === "on" && !fileId) {
            throw new ReleaseFileRequiredError();
          }
          // Migrated drafts were not backfilled. Validate the retained file
          // from this transaction's snapshot before reserving and locking it.
          const nuget = artifact?.nuget ?? (validated.data.published === "on" &&
            !current.published && !current.artifactLocked && !current.nugetMetadata && current.file
            ? await readNugetPackage(storedPackageReader(current.file.objectKey, Number(current.file.size)),
              { id: packageName, version: current.version }) : undefined);

          const replacedFileId =
            replacementFileId &&
            current.file?.id !== replacementFileId &&
            current.file?.userId === session.user.id
              ? current.file.id
              : undefined;
          const updated = await updateReleaseRecord({
            id: validated.data.id,
            title: validated.data.title,
            description: validated.data.description,
            targetVersion: validated.data.targetVersion,
            published: validated.data.published === "on",
            fileId,
            nuget,
            prisma: tx,
          });
          if (validated.data.translations) {
            await upsertReleaseTranslations({
              releaseId: validated.data.id,
              translations: validated.data.translations,
              prisma: tx,
            });
          }

          await refreshNugetPackageMetadata(tx, { id: release.packageId, audience: current.package.audience });

          // Merge the upload's kind into the current tags so concurrent edits survive.
          if (artifact?.packageType) {
            await updateDevPackageTags({
              packageId: release.packageId,
              tags: applyPackageType(devPackage.tags, artifact.packageType),
              prisma: tx,
            });
          }
          if (replacedFileId) {
            await deleteUnreferencedFileWithStorageCleanup({
              fileId: replacedFileId,
              userId: session.user.id,
              prisma: tx,
            });
          }
          return updated;
        };

        let data: ReleaseRecord;
        if (artifact) {
          let published: ReleaseRecord | undefined;
          const result = await createDedicatedFile(
            session.user.id,
            artifact.file,
            t,
            async (tx, record) => {
              published = await publishRelease(tx, record.id);
            },
          );
          if (!result.success) {
            return {
              success: result.success,
              message: result.message,
            };
          }

          if (!published) {
            throw new Error("Release artifact publication did not return a result");
          }
          data = published;
        } else {
          data = await startTransaction((tx) => publishRelease(tx));
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
        revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);

        return {
          success: true,
          data,
        };
      } catch (error) {
        if (error instanceof ReleaseFileRequiredError) return { success: false, message: t("developer:errors.fileNotFound") };
        if (error instanceof ReleaseArtifactLockedError) return { success: false, message: t("developer:release.artifactLocked") };
        if (error instanceof ReleaseIdentityConflictError) return { success: false, message: t("developer:release.versionReserved") };
        if (error instanceof InvalidNugetPackageError) return { success: false, message: error.message };
        throw error;
      }
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
      if (!isValidNugetVersion(version)) {
        return {
          success: false,
          message: t("developer:validation.versionInvalid"),
        };
      }

      try {
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
        revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);
        return {
          success: true,
          data: release,
        };
      } catch (error) {
        if (error instanceof ReleaseIdentityConflictError || (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")) {
          return { success: false, message: t("developer:release.versionReserved") };
        }
        throw error;
      }
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
      await deleteReleaseWithStorageCleanup({
        id: releaseId,
        userId: session.user.id,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deleteRelease,
        details: `releaseId: ${releaseId}`,
      });
      const name = await getPackageNameFromPackageId({
        packageId: release.packageId,
      });
      revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

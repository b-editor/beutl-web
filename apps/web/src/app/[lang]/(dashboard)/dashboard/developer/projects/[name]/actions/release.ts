"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { applyPackageType, isValidNugetVersion, type ActionResult } from "@beutl/core";
import { InvalidNugetPackageError } from "@beutl/api/nuget/archive";
import { refreshNugetPackageMetadata } from "@beutl/api/nuget/catalog";
import { ReleaseArtifactLockedError, ReleaseIdentityConflictError } from "@beutl/db";
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
            nuget: artifact?.nuget,
            prisma: tx,
          });

          if (current.package.audience === "DEVELOPMENT") {
            const pkg = await tx.package.findUniqueOrThrow({
              where: { id: release.packageId },
              include: { Release: { where: { published: true, nugetListed: true, fileId: { not: null } }, include: { file: true } } },
            });
            await refreshNugetPackageMetadata(tx, pkg);
          }

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

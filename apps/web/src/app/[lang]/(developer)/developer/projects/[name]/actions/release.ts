"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import {
  getPackageNameFromPackageId,
} from "@beutl/db";
import {
  createRelease as createReleaseRecord,
  deleteReleaseAndEnqueueArtifact,
  getReleasePackageAndFileId,
  getReleaseWithFileById,
  ReleaseArtifactConflictError,
  replaceReleaseArtifact,
  updateReleaseMetadata,
} from "@beutl/db";
import {
  abandonPendingStorageFile,
  drainStorageCleanup,
} from "@/lib/storage";
import {
  inspectPackageAnalyticsManifest,
  PackageAnalyticsManifestError,
} from "@/lib/analytics-manifest";
import { publishReleaseArtifactReplacement } from "@/lib/release-artifact-publication";
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
      let approvedAnalyticsManifestSha256: string | null = null;
      let uploadedFile:
        | Readonly<{
          id: string;
          sha256: string | null;
        }>
        | undefined;
      if (validated.data.file) {
        try {
          approvedAnalyticsManifestSha256 =
            await inspectPackageAnalyticsManifest(validated.data.file as File);
        } catch (error) {
          if (error instanceof PackageAnalyticsManifestError) {
            return {
              success: false,
              message: t("developer:errors.analyticsManifestInvalid"),
            };
          }
          throw error;
        }

        const deletedSize = release.file
          ? BigInt(release.file.size)
          : BigInt(0);
        const result = await createDedicatedFile(
          session.user.id,
          validated.data.file as File,
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
          throw new Error("The uploaded file record is missing.");
        }
        uploadedFile = result.record;
      }

      const oldPublished = release.published;
      const metadata = {
        title: validated.data.title,
        description: validated.data.description,
        targetVersion: validated.data.targetVersion,
        published: validated.data.published === "on",
      };
      let data: ReleaseRecord;
      if (uploadedFile) {
        try {
          data = await publishReleaseArtifactReplacement({
            replace: async () => {
              if (!uploadedFile.sha256) {
                throw new Error("The uploaded package digest is missing.");
              }

              return await replaceReleaseArtifact({
                id: validated.data.id,
                expectedFileId: release.fileId,
                metadata,
                artifact: {
                  fileId: uploadedFile.id,
                  packageSha256: uploadedFile.sha256,
                  approvedAnalyticsManifestSha256,
                },
              });
            },
            abandon: async () =>
              await abandonPendingStorageFile({ fileId: uploadedFile.id }),
            drain: drainStorageCleanup,
          });
        } catch (error) {
          if (error instanceof ReleaseArtifactConflictError) {
            return {
              success: false,
              message: t("developer:errors.releaseConflict"),
            };
          }
          throw error;
        }
      } else {
        data = await updateReleaseMetadata({
          id: validated.data.id,
          ...metadata,
        });
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

      const name = await getPackageNameFromPackageId({
        packageId: release.packageId,
      });
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
      try {
        await deleteReleaseAndEnqueueArtifact({
          id: releaseId,
          expectedFileId: release.fileId,
        });
      } catch (error) {
        if (error instanceof ReleaseArtifactConflictError) {
          return {
            success: false,
            message: t("developer:errors.releaseConflict"),
          };
        }
        throw error;
      }
      await drainStorageCleanup();
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

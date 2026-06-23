"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@/lib/action-result";
import { authenticated } from "@/lib/auth-guard";
import {
  getPackageNameFromPackageId,
} from "@/lib/db/package";
import {
  createRelease as createReleaseRecord,
  deleteReleaseById,
  getReleasePackageAndFileId,
  getReleasePublishedByIdOrThrow,
  getReleaseWithFileById,
  updateRelease as updateReleaseRecord,
} from "@/lib/db/release";
import {
  deleteStorageFile,
} from "@/lib/storage";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
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
      if (validated.data.file) {
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

        if (release.file) {
          await deleteStorageFile({
            fileId: release.file.id,
          });
        }
        fileId = result.record!.id;
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

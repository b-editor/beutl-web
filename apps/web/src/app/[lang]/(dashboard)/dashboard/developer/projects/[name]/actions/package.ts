"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { isReservedPackageTag, MATERIAL_TAG, TEMPLATE_TAG } from "@beutl/core";
import type { ActionResult } from "@beutl/core";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { contentPath } from "@/lib/content-url";
import {
  deleteDevPackage,
  getPackageNameFromPackageId,
  getPackagePublishedByIdOrThrow,
  retrieveDevPackageByName,
  startTransaction,
  updateDevPackageDescription,
  updateDevPackageDisplay,
  replaceDevPackageIconFile,
  updateDevPackagePublished,
  updateDevPackageTags,
  upsertPackageTranslations,
} from "@beutl/db";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { compareNugetVersions } from "@beutl/core";
import {
  createDedicatedFile,
  descriptionUpdateSchema,
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

    const { displayName, shortDescription, id, translations } = validated.data;
    return await sameUser(id, session.user.id, t, async () => {
      const { name } = await startTransaction(async (tx) => {
        const updated = await updateDevPackageDisplay({
          packageId: id,
          displayName,
          shortDescription,
          prisma: tx,
        });
        if (translations) {
          await upsertPackageTranslations({
            packageId: id,
            translations,
            prisma: tx,
          });
        }
        return updated;
      });
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

export async function updateDescription({
  packageId,
  description,
  translations,
}: {
  packageId: string;
  description: string;
  translations?: { lang: string; shortDescription?: string | null; description?: string | null }[];
}): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const validated = descriptionUpdateSchema(t).safeParse({
      packageId,
      description,
      translations,
    });
    if (!validated.success) {
      return {
        message: validated.error.issues[0]?.message ??
          t("developer:errors.invalidInput"),
        success: false,
      };
    }

    return await sameUser(packageId, session.user.id, t, async () => {
      const { name } = await startTransaction(async (tx) => {
        const updated = await updateDevPackageDescription({
          packageId,
          description: validated.data.description,
          prisma: tx,
        });
        if (validated.data.translations) {
          await upsertPackageTranslations({
            packageId,
            translations: validated.data.translations,
            prisma: tx,
          });
        }
        return updated;
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

export async function retrievePackage(name: string) {
  const session = await throwIfUnauth();
  const pkg = await retrieveDevPackageByName({ name, userId: session.user.id });
  if (!pkg) {
    return null;
  }
  pkg.Release.sort((a, b) => {
    return compareNugetVersions(b.version, a.version);
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
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deletePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/${lang}/dashboard/developer`);
      redirect(`/${lang}/dashboard/developer`);
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
      revalidatePath(`/${lang}/dashboard/developer/projects/${name}`);
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
      const result = await createDedicatedFile(
        session.user.id,
        file,
        t,
        async (tx, record) => {
          await replaceDevPackageIconFile({
            packageId: id,
            fileId: record.id,
            prisma: tx,
          });
        },
      );
      if (!result.success) {
        return {
          success: result.success,
          message: result.message,
        };
      }

      const name = await getPackageNameFromPackageId({ packageId: id });
      if (!name) {
        return { success: false, message: t("developer:errors.idNotFound") };
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

export async function updateTag({
  packageId,
  tags,
}: { packageId: string; tags: string[] }): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    return await sameUser(packageId, session.user.id, t, async () => {
      // The kind is one or both reserved markers; anything else would be ambiguous,
      // and the client already refuses to type them, so reject it at the boundary too.
      const markers = tags.filter(isReservedPackageTag);
      const bothPair = markers.length === 2
        && markers.includes(MATERIAL_TAG)
        && markers.includes(TEMPLATE_TAG);
      if (markers.length > 2 || (markers.length === 2 && !bothPair)) {
        return {
          success: false,
          message: t("developer:details.reservedTag"),
        };
      }

      const { name } = await updateDevPackageTags({
        packageId,
        tags,
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

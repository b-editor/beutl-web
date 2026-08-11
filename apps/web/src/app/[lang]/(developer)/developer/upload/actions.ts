"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { authenticated } from "@/lib/auth-guard";
import { buildNupkg, MATERIAL_TAG, TEMPLATE_TAG } from "@beutl/core";
import type { ActionResult } from "@beutl/core";
import {
  createDevPackage,
  createRelease as createReleaseRecord,
  existsPackageName,
  getProfileByUserId,
  updateDevPackagePublished,
  updateDevPackageTags,
  updateRelease as updateReleaseRecord,
} from "@beutl/db";
import { calcTotalFileSize, createStorageFile } from "@/lib/storage";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const MATERIAL_EXTENSIONS = [
  ".bmp", ".gif", ".ico", ".jpg", ".jpeg", ".png", ".webp", ".wbmp", ".avif", ".heif",
  ".wav", ".mp3", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".opus",
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".mpg", ".mpeg",
  ".ttf", ".ttc", ".otf",
];

const MAX_STORAGE = BigInt(1024 * 1024 * 1024); // 1GB

function sanitizeIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function publishDataPackage(
  formData: FormData,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);

    const type = formData.get("type");
    const slug = ((formData.get("slug") as string) ?? "").trim();
    const title = ((formData.get("title") as string) ?? "").trim();
    const description = ((formData.get("description") as string) ?? "").trim();
    const files = formData.getAll("file") as File[];

    if (type !== "material" && type !== "template") {
      return { success: false, message: t("developer:upload.invalidType") };
    }
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
      return { success: false, message: t("developer:upload.invalidSlug") };
    }
    if (!title || title.length > 50) {
      return { success: false, message: t("developer:upload.invalidTitle") };
    }
    if (!description || description.length > 1000) {
      return { success: false, message: t("developer:upload.invalidDescription") };
    }
    if (files.length === 0) {
      return { success: false, message: t("developer:upload.noFiles") };
    }

    const allowed = type === "material" ? MATERIAL_EXTENSIONS : [".json"];
    for (const file of files) {
      const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
      if (!allowed.includes(ext)) {
        return {
          success: false,
          message: t("developer:upload.invalidFile", { name: file.name }),
        };
      }
    }

    const profile = await getProfileByUserId(session.user.id);
    const username = sanitizeIdPart(
      profile?.userName || session.user.name || session.user.id,
    );
    const id =
      type === "material"
        ? `Beutl.Materials.${username}.${slug}`
        : `Beutl.Templates.${username}.${slug}`;

    if (await existsPackageName({ name: id })) {
      return { success: false, message: t("developer:upload.nameTaken") };
    }

    const tag = type === "material" ? MATERIAL_TAG : TEMPLATE_TAG;
    const nupkg = buildNupkg({
      id,
      version: "1.0.0",
      title,
      description,
      tags: [tag],
      authors: username,
      contentDir: type === "material" ? "materials" : "templates",
      files: await Promise.all(
        files.map(async (file) => ({
          path: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    });

    const nupkgFile = new File([nupkg], `${id}.1.0.0.nupkg`, {
      type: "application/octet-stream",
    });
    const totalSize = await calcTotalFileSize({ userId: session.user.id });
    if (totalSize + BigInt(nupkgFile.size) > MAX_STORAGE) {
      return { success: false, message: t("developer:errors.storageFull") };
    }

    const pkg = await createDevPackage({ name: id, userId: session.user.id });
    await updateDevPackageTags({ packageId: pkg.id, tags: [tag] });

    const release = await createReleaseRecord({
      packageId: pkg.id,
      version: "1.0.0",
      title,
      description,
      targetVersion: "1.0.0-preview.10",
      published: false,
    });

    const stored = await createStorageFile({
      file: nupkgFile,
      visibility: "DEDICATED",
      userId: session.user.id,
    });

    await updateReleaseRecord({
      id: release.id,
      title,
      description,
      targetVersion: "1.0.0-preview.10",
      published: true,
      fileId: stored.id,
    });

    await updateDevPackagePublished({ packageId: pkg.id, published: true });

    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.developer.createPackage,
      details: `packageId: ${id}`,
    });

    revalidatePath(`/${lang}/developer`);
    redirect(`/${lang}/developer/projects/${id}`);
  });
}

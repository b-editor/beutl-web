"use server";

import { drizzle } from "@/drizzle";
import { file } from "@/drizzle/schema";
import { eq, inArray, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type Response = {
  success: boolean;
  message?: string;
};
export async function deleteFile(ids: string[]): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const db = await drizzle();
    const files = await db
      .select({
        objectKey: file.objectKey,
        id: file.id,
        visibility: file.visibility,
      })
      .from(file)
      .where(
        and(
          eq(file.userId, session.user.id),
          inArray(file.id, ids)
        )
      );
    if (!files.length) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }
    if (files.some((f) => f.visibility === "DEDICATED")) {
      return {
        success: false,
        message: t("storage:cannotDeleteFileInUse"),
      };
    }

    const promises = files.map(async (f) => {
      await db.delete(file).where(eq(file.id, f.id));

      const bucket = (await getCloudflareContext({ async: true })).env.BEUTL_R2_BUCKET;
      await bucket.delete(f.objectKey);
    });
    await Promise.all(promises);

    revalidatePath("/storage");
    return {
      success: true,
    };
  });
}

export async function changeFileVisibility(
  ids: string[],
  visibility: "PRIVATE" | "PUBLIC",
): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const db = await drizzle();
    if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
      return {
        success: false,
        message: t("zod:custom"),
      };
    }

    const files = await db
      .select({
        objectKey: file.objectKey,
        id: file.id,
        visibility: file.visibility,
      })
      .from(file)
      .where(
        and(
          eq(file.userId, session.user.id),
          inArray(file.id, ids)
        )
      );
    if (!files.length) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }
    if (files.some((f) => f.visibility === "DEDICATED")) {
      return {
        success: false,
        message: t("storage:cannotChangeVisibilityOfFileInUse"),
      };
    }

    const promises = files.map(async (f) => {
      await db
        .update(file)
        .set({ visibility: visibility })
        .where(eq(file.id, f.id));
    });
    await Promise.all(promises);

    revalidatePath("/storage");
    return {
      success: true,
    };
  });
}

export async function uploadFile(formData: FormData): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const uploadedFile = formData.get("file") as File;
    if (!uploadedFile) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }

    const db = await drizzle();
    const files = await db
      .select({
        size: file.size,
        name: file.name,
      })
      .from(file)
      .where(eq(file.userId, session.user.id));

    const maxSize = BigInt(1024 * 1024 * 1024); // 1GB
    let totalSize = BigInt(0);
    for (const f of files) {
      totalSize += BigInt(f.size);
    }

    if (totalSize + BigInt(uploadedFile.size) > maxSize) {
      return {
        success: false,
        message: t("storage:insufficientStorageSpace"),
      };
    }

    let filename = uploadedFile.name;
    const ext = uploadedFile.name.split(".").pop();
    for (let i = 1; files.some((f) => f.name === filename); i++) {
      filename = ext
        ? uploadedFile.name.replace(`.${ext}`, ` (${i}).${ext}`)
        : `${uploadedFile.name} (${i})`;
    }

    const objectKey = crypto.randomUUID();
    const bucket = (await getCloudflareContext({ async: true })).env.BEUTL_R2_BUCKET;
    bucket.put(
      objectKey,
      await uploadedFile.arrayBuffer(),
    );
    await db.insert(file).values({
      objectKey,
      name: filename,
      size: uploadedFile.size,
      mimeType: uploadedFile.type,
      userId: session.user.id,
      visibility: "PRIVATE",
    });
    revalidatePath("/storage");
    return {
      success: true,
    };
  });
}

export async function retrieveFiles() {
  const session = await throwIfUnauth();
  const db = await drizzle();
  return await db
    .select({
      id: file.id,
      objectKey: file.objectKey,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      visibility: file.visibility,
    })
    .from(file)
    .where(eq(file.userId, session?.user?.id));
}

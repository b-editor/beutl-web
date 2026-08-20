"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import type { ActionResult } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  deleteFile as deleteFileRecord,
  retrieveFilesByIdsAndUserId,
  retrieveStorageFilesByUserId,
  sumFileSizeByUserId,
  updateFileVisibility,
} from "@beutl/db";

export async function deleteFile(ids: string[]): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const files = await retrieveFilesByIdsAndUserId({
      ids,
      userId: session.user.id,
    });
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

    const promises = files.map(async (file) => {
      await deleteFileRecord({
        fileId: file.id,
      });

      const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
      await bucket.delete(file.objectKey);
    });
    await Promise.all(promises);

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function changeFileVisibility(
  ids: string[],
  visibility: "PRIVATE" | "PUBLIC",
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
      return {
        success: false,
        message: t("invalidRequest"),
      };
    }

    const files = await retrieveFilesByIdsAndUserId({
      ids,
      userId: session.user.id,
    });
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

    const promises = files.map(async (file) => {
      await updateFileVisibility({
        fileId: file.id,
        visibility: visibility,
      });
    });
    await Promise.all(promises);

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function retrieveFiles() {
  const session = await throwIfUnauth();
  return await retrieveStorageFilesByUserId({
    userId: session?.user?.id,
  });
}

// アップロードの可否はユーザーが持つ全ファイルの合計で決まる。一覧は AI の出力を
// 含まないので、一覧を足し上げた数字を使用量として見せると、画面上は空きがあるのに
// アップロードだけが拒否される。判定に使われている合計をそのまま返す。
export async function retrieveStorageUsage(): Promise<
  { total: bigint; listed: bigint }
> {
  const session = await throwIfUnauth();
  const userId = session?.user?.id;
  if (!userId) return { total: BigInt(0), listed: BigInt(0) };

  const [total, files] = await Promise.all([
    sumFileSizeByUserId({ userId }),
    retrieveStorageFilesByUserId({ userId }),
  ]);
  let listed = BigInt(0);
  for (const file of files) listed += BigInt(file.size);
  return { total, listed };
}

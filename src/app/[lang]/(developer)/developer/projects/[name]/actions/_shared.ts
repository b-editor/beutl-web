import "server-only";

import { getUserIdFromPackageId } from "@/lib/db/package";
import type { updateRelease as updateReleaseRecord } from "@/lib/db/release";
import { isValidNuGetVersionRange } from "@/lib/nuget-version-range";
import {
  calcTotalFileSize,
  createStorageFile,
} from "@/lib/storage";
import SemVer from "semver";
import { z } from "zod";

export type State = {
  errors?: {
    displayName?: string[];
    shortDescription?: string[];
  };
  success?: boolean;
  message?: string | null;
};
type ReleaseRecord = Awaited<ReturnType<typeof updateReleaseRecord>>;

const displayNameAndShortDescriptionSchema = z.object({
  displayName: z.string().max(50, "表示名は50文字以下である必要があります"),
  shortDescription: z
    .string()
    .max(200, "短い説明は200文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
});

const releaseSchema = z.object({
  title: z.string().max(50, "タイトルは50文字以下である必要があります"),
  description: z.string().max(1000, "説明は1000文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
  targetVersion: z
    .string()
    .refine(
      (v) => SemVer.valid(v) || isValidNuGetVersionRange(v),
      "バージョンが不正です",
    ),
  published: z
    .string()
    .refine((v) => v === "on" || v === "off", "公開設定が不正です"),
  file: z.any()
});

async function sameUser<TResult>(
  packageId: string,
  userId: string,
  fnc: () => Promise<TResult>,
) {
  const pkgUserId = await getUserIdFromPackageId({ packageId });
  if (!pkgUserId) {
    return {
      success: false,
      message: "IDが見つかりません",
    };
  }

  if (pkgUserId !== userId) {
    return {
      success: false,
      message: "権限がありません",
    };
  }

  return await fnc();
}

async function createDedicatedFile(userId: string, file: File, size: bigint) {
  const maxSize = BigInt(1024 * 1024 * 1024); // 1GB
  let totalSize = await calcTotalFileSize({ userId });
  totalSize -= size;

  if (totalSize + BigInt(file.size) > maxSize) {
    return {
      success: false,
      message: "ストレージ容量が足りません",
    };
  }

  const record = await createStorageFile({
    file,
    visibility: "DEDICATED",
    userId,
  });

  return {
    success: true,
    record,
  };
}

const pricingSchema = z.object({
  packageId: z.string().uuid(),
  pricings: z.array(
    z.object({
      currency: z.string().length(3, "通貨コードは3文字である必要があります"),
      price: z.number().int().min(0, "価格は0以上である必要があります"),
      fallback: z.boolean(),
    }),
  ).refine(
    (pricings) => pricings.filter((p) => p.fallback).length <= 1,
    "デフォルト通貨は1つまでです",
  ),
});

const intervalSchema = z.object({
  packageId: z.string().uuid(),
  interval: z.enum(["ONCE", "MONTHLY", "YEARLY"]).nullable(),
});

export {
  createDedicatedFile,
  displayNameAndShortDescriptionSchema,
  intervalSchema,
  pricingSchema,
  releaseSchema,
  sameUser,
};
export type { ReleaseRecord };

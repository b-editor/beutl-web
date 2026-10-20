import "server-only";

import { getUserIdFromPackageId } from "@beutl/db";
import type { updateRelease as updateReleaseRecord } from "@beutl/db";
import { isValidNuGetVersionRange } from "@beutl/core";
import { createDedicatedStorageFile } from "@/lib/storage";
import type { StorageUploadFile } from "@/lib/storage";
import type { PrismaTransaction } from "@beutl/db";
import { isAvailableLanguage } from "@beutl/i18n";
import type { Translator } from "@beutl/i18n";
import SemVer from "semver";
import { z } from "zod";

export type State = {
  errors?: {
    displayName?: string[];
    shortDescription?: string[];
    translations?: string[];
  };
  success?: boolean;
  message?: string | null;
};
type ReleaseRecord = Awaited<ReturnType<typeof updateReleaseRecord>>;

// 画面から届く翻訳の下書き。原文 (displayName など) とは別に、言語コードごとの
// 上書きだけを運ぶ。空文字は「その言語の翻訳を消す」と同じ意味で、DB 側で行の
// 削除になる（原文フォールバックに戻る）。
const packageTranslationSchema = (t: Translator) =>
  z.object({
    lang: z
      .string()
      .refine(isAvailableLanguage, t("developer:validation.languageUnsupported")),
    displayName: z
      .string()
      .max(50, t("developer:validation.displayNameMax"))
      .nullish(),
    shortDescription: z
      .string()
      .max(200, t("developer:validation.shortDescriptionMax"))
      .nullish(),
    description: z
      .string()
      .max(1000, t("developer:validation.descriptionMax"))
      .nullish(),
  });

const releaseTranslationSchema = (t: Translator) =>
  z.object({
    lang: z
      .string()
      .refine(isAvailableLanguage, t("developer:validation.languageUnsupported")),
    description: z
      .string()
      .max(1000, t("developer:validation.descriptionMax"))
      .nullish(),
  });

// FormData の translations フィールドは JSON 文字列。未指定・空文字は「翻訳に
// 触らない」ではなく「全言語ぶんの下書きが無い」を意味する。
const translationsJson = <T extends z.ZodType>(t: Translator, item: T) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        // JSON として読めないこと自体が検証したい事実なので、原因は
        // エラーではなくフィールドのエラーとして返す。
        ctx.addIssue({
          code: "custom",
          message: t("developer:validation.translationsInvalid"),
        });
        return z.NEVER;
      }
      const result = z.array(item).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          message:
            result.error.issues[0]?.message ??
            t("developer:validation.translationsInvalid"),
        });
        return z.NEVER;
      }
      return result.data as z.output<T>[];
    });

const displayNameAndShortDescriptionSchema = (t: Translator) =>
  z.object({
    displayName: z.string().max(50, t("developer:validation.displayNameMax")),
    shortDescription: z
      .string()
      .max(200, t("developer:validation.shortDescriptionMax")),
    id: z.string().uuid(t("developer:validation.idInvalid")),
    translations: translationsJson(t, packageTranslationSchema(t)),
  });

const releaseSchema = (t: Translator) =>
  z.object({
    title: z.string().max(50, t("developer:validation.titleMax")),
    description: z.string().max(1000, t("developer:validation.descriptionMax")),
    id: z.string().uuid(t("developer:validation.idInvalid")),
    translations: translationsJson(t, releaseTranslationSchema(t)),
    targetVersion: z
      .string()
      .refine(
        (v) => v === "" || SemVer.valid(v) || isValidNuGetVersionRange(v),
        t("developer:validation.versionInvalid"),
      ),
    published: z
      .string()
      .refine(
        (v) => v === "on" || v === "off",
        t("developer:validation.publishedInvalid"),
      ),
    file: z.any().optional(),
  });

const descriptionUpdateSchema = (t: Translator) =>
  z.object({
    packageId: z.string().uuid(t("developer:validation.idInvalid")),
    description: z.string().max(1000, t("developer:validation.descriptionMax")),
    translations: z.array(packageTranslationSchema(t)).optional(),
  });

async function sameUser<TResult>(
  packageId: string,
  userId: string,
  t: Translator,
  fnc: () => Promise<TResult>,
) {
  const pkgUserId = await getUserIdFromPackageId({ packageId });
  if (!pkgUserId) {
    return {
      success: false,
      message: t("developer:errors.idNotFound"),
    };
  }

  if (pkgUserId !== userId) {
    return {
      success: false,
      message: t("developer:errors.noPermission"),
    };
  }

  return await fnc();
}

async function createDedicatedFile(
  userId: string,
  file: StorageUploadFile,
  t: Translator,
  publish?: (tx: PrismaTransaction, record: { id: string; objectKey: string; size: bigint }) => Promise<void>,
) {
  // Reserve the replacement before uploading. The optional publication callback
  // swaps the owning relation and retires the previous File in that same commit
  // transaction, while failed writes remain covered by the durable cleanup outbox.
  const outcome = await createDedicatedStorageFile({
    file,
    userId,
    publish,
  });
  if (outcome.kind === "overQuota") return { success: false, message: t("developer:errors.storageFull") };
  if (outcome.kind === "tooManyFiles") return { success: false, message: t("developer:errors.storageFull") };

  return {
    success: true,
    record: outcome.record,
  };
}

const pricingSchema = (t: Translator) =>
  z.object({
    packageId: z.string().uuid(),
    pricings: z.array(
      z.object({
        currency: z.string().length(3, t("developer:validation.currencyCodeLength")),
        price: z.number().int().min(0, t("developer:validation.priceMin")),
        fallback: z.boolean(),
      }),
    ).refine(
      (pricings) => pricings.filter((p) => p.fallback).length <= 1,
      t("developer:validation.defaultCurrencyMax"),
    ),
  });

const intervalSchema = z.object({
  packageId: z.string().uuid(),
  interval: z.enum(["ONCE", "MONTHLY", "YEARLY"]).nullable(),
});

export {
  createDedicatedFile,
  descriptionUpdateSchema,
  displayNameAndShortDescriptionSchema,
  intervalSchema,
  pricingSchema,
  releaseSchema,
  sameUser,
};
export type { ReleaseRecord };

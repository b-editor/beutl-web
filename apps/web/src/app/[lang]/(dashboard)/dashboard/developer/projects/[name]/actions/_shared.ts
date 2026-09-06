import "server-only";

import { getUserIdFromPackageId } from "@beutl/db";
import type { updateRelease as updateReleaseRecord } from "@beutl/db";
import { isValidNuGetVersionRange, STORAGE_FILE_COUNT_LIMIT, STORAGE_QUOTA_BYTES } from "@beutl/core";
import { createDedicatedStorageFile } from "@/lib/storage";
import type { PrismaTransaction } from "@beutl/db";
import type { Translator } from "@beutl/i18n";
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

const displayNameAndShortDescriptionSchema = (t: Translator) =>
  z.object({
    displayName: z.string().max(50, t("developer:validation.displayNameMax")),
    shortDescription: z
      .string()
      .max(200, t("developer:validation.shortDescriptionMax")),
    id: z.string().uuid(t("developer:validation.idInvalid")),
  });

const releaseSchema = (t: Translator) =>
  z.object({
    title: z.string().max(50, t("developer:validation.titleMax")),
    description: z.string().max(1000, t("developer:validation.descriptionMax")),
    id: z.string().uuid(t("developer:validation.idInvalid")),
    targetVersion: z
      .string()
      .refine(
        (v) => SemVer.valid(v) || isValidNuGetVersionRange(v),
        t("developer:validation.versionInvalid"),
      ),
    published: z
      .string()
      .refine(
        (v) => v === "on" || v === "off",
        t("developer:validation.publishedInvalid"),
      ),
    file: z.any(),
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
  file: File,
  t: Translator,
  publish?: (tx: PrismaTransaction, record: { id: string; objectKey: string; size: bigint }) => Promise<void>,
) {
  // Reserve the replacement before uploading. The optional publication callback
  // swaps the owning relation and retires the previous File in that same commit
  // transaction, while failed writes remain covered by the durable cleanup outbox.
  const outcome = await createDedicatedStorageFile({
    file,
    userId,
    quotaBytes: BigInt(STORAGE_QUOTA_BYTES),
    fileCountLimit: STORAGE_FILE_COUNT_LIMIT,
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
  displayNameAndShortDescriptionSchema,
  intervalSchema,
  pricingSchema,
  releaseSchema,
  sameUser,
};
export type { ReleaseRecord };

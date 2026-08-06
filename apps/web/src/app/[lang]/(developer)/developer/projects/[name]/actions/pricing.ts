"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import {
  getPackageNameFromPackageId,
  updatePackageInterval,
  upsertPackagePricings,
} from "@beutl/db";
import type { PaymentInterval } from "@prisma/client";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@beutl/i18n";
import { revalidatePath } from "next/cache";
import { intervalSchema, pricingSchema, sameUser } from "./_shared";

export async function updatePricing({
  packageId,
  pricings,
}: {
  packageId: string;
  pricings: { currency: string; price: number; fallback: boolean }[];
}): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    if (!isAdmin(session.user.id)) {
      return { success: false, message: t("developer:errors.noPermission") };
    }

    const validated = pricingSchema(t).safeParse({ packageId, pricings });
    if (!validated.success) {
      return {
        success: false,
        message: t("developer:errors.invalidInput"),
      };
    }

    return await sameUser(packageId, session.user.id, t, async () => {
      await upsertPackagePricings({ packageId, pricings });
      const name = await getPackageNameFromPackageId({ packageId });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.updatePackagePricing,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return { success: true };
    });
  });
}

export async function updateInterval({
  packageId,
  interval,
}: {
  packageId: string;
  interval: PaymentInterval | null;
}): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    if (!isAdmin(session.user.id)) {
      return { success: false, message: t("developer:errors.noPermission") };
    }

    const validated = intervalSchema.safeParse({ packageId, interval });
    if (!validated.success) {
      return {
        success: false,
        message: t("developer:errors.invalidInput"),
      };
    }

    return await sameUser(packageId, session.user.id, t, async () => {
      const { name } = await updatePackageInterval({ packageId, interval });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.updatePackageInterval,
        details: `packageId: ${packageId}, interval: ${interval}`,
      });
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return { success: true };
    });
  });
}

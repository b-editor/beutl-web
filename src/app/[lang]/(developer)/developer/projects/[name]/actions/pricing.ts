"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@/lib/action-result";
import { authenticated } from "@/lib/auth-guard";
import { isAdmin } from "@/lib/admin-guard";
import {
  getPackageNameFromPackageId,
  updatePackageInterval,
  upsertPackagePricings,
} from "@/lib/db/package";
import type { PaymentInterval } from "@prisma/client";
import { getLanguage } from "@/lib/lang-utils";
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
    if (!isAdmin(session.user.id)) {
      return { success: false, message: "権限がありません" };
    }

    const validated = pricingSchema.safeParse({ packageId, pricings });
    if (!validated.success) {
      return {
        success: false,
        message: "入力内容に誤りがあります",
      };
    }

    return await sameUser(packageId, session.user.id, async () => {
      await upsertPackagePricings({ packageId, pricings });
      const name = await getPackageNameFromPackageId({ packageId });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.updatePackagePricing,
        details: `packageId: ${packageId}`,
      });
      const lang = await getLanguage();
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
    if (!isAdmin(session.user.id)) {
      return { success: false, message: "権限がありません" };
    }

    const validated = intervalSchema.safeParse({ packageId, interval });
    if (!validated.success) {
      return {
        success: false,
        message: "入力内容に誤りがあります",
      };
    }

    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await updatePackageInterval({ packageId, interval });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.updatePackageInterval,
        details: `packageId: ${packageId}, interval: ${interval}`,
      });
      const lang = await getLanguage();
      revalidatePath(`/${lang}/developer/projects/${name}`);
      return { success: true };
    });
  });
}

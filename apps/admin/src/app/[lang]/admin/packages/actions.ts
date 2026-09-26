"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  setPackagePublishedByAdmin,
  setReleasePublishedByAdmin,
  startRetryableTransaction,
} from "@beutl/db";
import { revalidatePath } from "next/cache";

// 公開状態の強制変更は開発者の意図を覆す操作なので、後から経緯を辿れるよう理由を必須にする。
const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;

function parseInput(input: unknown, idKey: "packageId" | "releaseId") {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const id = value[idKey];
  const { published, reason } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) return null;
  if (typeof published !== "boolean") return null;
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH || trimmed.length > MAX_REASON_LENGTH) return null;
  return { id, published, reason: trimmed };
}

function revalidatePackagePages() {
  // middleware が既定ロケールを rewrite するため、ルートパターンで全ロケールをまとめて破棄する。
  revalidatePath("/[lang]/admin/packages", "page");
  revalidatePath("/[lang]/admin/packages/[id]", "page");
}

export async function setPackagePublished(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const parsed = parseInput(input, "packageId");
    if (!parsed) return { success: false, message: "Invalid input" };

    const result = await startRetryableTransaction(async (tx) => {
      const updated = await setPackagePublishedByAdmin({
        packageId: parsed.id,
        published: parsed.published,
        prisma: tx,
      });
      if (updated?.changed) {
        await addAuditLog({
          userId: session.user.id,
          action: parsed.published
            ? auditLogActions.admin.packagePublished
            : auditLogActions.admin.packageUnpublished,
          details: `packageId: ${parsed.id}, name: ${updated.name}, reason: ${parsed.reason}`,
          prisma: tx,
        });
      }
      return updated;
    });
    if (!result) return { success: false, message: "Package not found" };

    revalidatePackagePages();
    return { success: true };
  });
}

export async function setReleasePublished(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const parsed = parseInput(input, "releaseId");
    if (!parsed) return { success: false, message: "Invalid input" };

    const result = await startRetryableTransaction(async (tx) => {
      const updated = await setReleasePublishedByAdmin({
        releaseId: parsed.id,
        published: parsed.published,
        prisma: tx,
      });
      if (updated?.changed) {
        await addAuditLog({
          userId: session.user.id,
          action: parsed.published
            ? auditLogActions.admin.releasePublished
            : auditLogActions.admin.releaseUnpublished,
          details: `releaseId: ${parsed.id}, packageId: ${updated.packageId}, version: ${updated.version}, reason: ${parsed.reason}`,
          prisma: tx,
        });
      }
      return updated;
    });
    if (!result) return { success: false, message: "Release not found" };
    if (result.missingFile) {
      return { success: false, message: "A release without a file cannot be published" };
    }

    revalidatePackagePages();
    return { success: true };
  });
}

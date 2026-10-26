"use server";

import { createHash } from "node:crypto";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  getDb,
  setPackagePublishedByAdmin,
  setReleasePublishedByAdmin,
  startRetryableTransaction,
} from "@beutl/db";
import { getStorageStores } from "@/lib/storage";
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
    if (result.requiresUpload) {
      return { success: false, message: "Upload a valid NuGet package before publishing this release" };
    }

    revalidatePackagePages();
    return { success: true };
  });
}


const MAX_HASH_REPAIRS = 20;

async function sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return hash.digest("hex");
}

/** Recompute the SHA-256 of published release files that were uploaded before
 * the multipart path recorded one. The NuGet download ETag is this value, and
 * the desktop app verifies it when installing a package. */
export async function repairMissingReleaseSha256(): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const db = await getDb();
    const releases = await db.release.findMany({
      where: { published: true, file: { is: { sha256: null } } },
      select: {
        id: true,
        file: { select: { id: true, objectKey: true } },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_HASH_REPAIRS,
    });
    if (releases.length === 0) {
      return { success: true, message: "No missing SHA-256." };
    }

    const { stores } = await getStorageStores();
    let repaired = 0;
    let failed = 0;
    for (const release of releases) {
      const file = release.file;
      if (!file) continue;
      let sha256: string | undefined;
      for (const store of stores) {
        try {
          const object = await store.bucket.get?.(file.objectKey);
          if (!object?.body) continue;
          sha256 = await sha256OfStream(object.body);
          break;
        } catch (error) {
          console.error("Failed to read a release file for hashing", file.objectKey, error);
        }
      }
      if (!sha256) {
        failed++;
        continue;
      }
      await db.file.update({
        where: { id: file.id },
        data: { sha256 },
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.releaseSha256Repaired,
        details: `fileId: ${file.id}, releaseId: ${release.id}, sha256: ${sha256}`,
      });
      repaired++;
    }

    revalidatePackagePages();
    return {
      success: true,
      message: `Repaired ${repaired} file hash(es)${failed > 0 ? `; ${failed} could not be read` : ""}.`,
    };
  });
}

"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { findFileForAdminById, listFilesForAdminAfter } from "@beutl/db";
import {
  moveStorageObject,
  moveStorageObjectsBatch,
  StorageMoveError,
  type MoveBatchOutcome,
  type MoveOutcome,
  type MovableFile,
  type StorageProvider,
} from "@beutl/api";
import { adminAction } from "@/lib/auth-guard";
import {
  decodeFileCursor,
  encodeFileCursor,
  getStorageStores,
  isStorageProvider,
} from "@/lib/storage";

// 1 回の一括実行の上限。応答が Cloudflare の待ち時間に収まるよう、移動する本数と
// 走査する行数と経過時間の 3 つで区切る。
const BATCH_PAGE_SIZE = 25;
const BATCH_MAX_MOVES = 20;
const BATCH_MAX_SCANNED = 250;
const BATCH_MILLISECONDS = 20_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Every outcome that deleted a copy is recorded, including the removal of a
// leftover copy when the object was already at the destination.
async function recordMove({
  operatorUserId,
  file,
  outcome,
}: {
  operatorUserId: string;
  file: { id: string; objectKey: string };
  outcome: Extract<MoveOutcome, { kind: "moved" | "already-there" }>;
}): Promise<void> {
  const details =
    outcome.kind === "moved"
      ? `fileId: ${file.id}, objectKey: ${file.objectKey}, from: ${outcome.from}, to: ${outcome.to}, size: ${outcome.size}${outcome.sourceRemoved ? "" : ", sourceRemoved: false"}`
      : `fileId: ${file.id}, objectKey: ${file.objectKey}, to: ${outcome.to}, leftoverRemovedFrom: ${outcome.removedFrom.join("+")}`;
  try {
    await addAuditLog({
      userId: operatorUserId,
      action: auditLogActions.admin.storageObjectMoved,
      details,
    });
  } catch (error) {
    // The object has moved either way; a lost audit row must not undo that.
    console.error("Failed to record a storage object move", file.id, error);
  }
}

export async function moveFileToProvider(
  lang: string,
  input: unknown,
): Promise<ActionResult> {
  const { t } = await getTranslation(lang);
  return await adminAction(async (session) => {
    if (!input || typeof input !== "object") {
      return { success: false, message: t("admin:storage.messages.invalidInput") };
    }
    const { fileId, to } = input as Record<string, unknown>;
    if (typeof fileId !== "string" || !isStorageProvider(to)) {
      return { success: false, message: t("admin:storage.messages.invalidInput") };
    }
    const { stores } = await getStorageStores();
    if (!stores.some((store) => store.provider === to)) {
      return { success: false, message: t("admin:storage.messages.notConfigured") };
    }
    const file = await findFileForAdminById({ id: fileId });
    if (!file) return { success: false, message: t("admin:storage.noResults") };

    const providerName = (provider: StorageProvider) =>
      t(`admin:storage.providers.${provider}`);
    try {
      const outcome = await moveStorageObject({
        objectKey: file.objectKey,
        to,
        stores,
        expectedSize: Number(file.size),
        contentType: file.mimeType,
        // A file deleted while its copy was in flight must not come back.
        stillWanted: async () => (await findFileForAdminById({ id: file.id })) !== null,
      });
      if (outcome.kind === "moved") {
        await recordMove({ operatorUserId: session.user.id, file, outcome });
        return {
          success: true,
          message: t(
            outcome.sourceRemoved
              ? "admin:storage.messages.moved"
              : "admin:storage.messages.movedSourceLeft",
            { name: file.name, from: providerName(outcome.from), to: providerName(to) },
          ),
        };
      }
      if (outcome.kind === "already-there") {
        if (outcome.removedFrom.length > 0) {
          await recordMove({ operatorUserId: session.user.id, file, outcome });
        }
        return {
          success: true,
          message: t("admin:storage.messages.alreadyThere", {
            name: file.name,
            to: providerName(to),
          }),
        };
      }
      return { success: false, message: t("admin:storage.messages.missing", { name: file.name }) };
    } catch (error) {
      console.error("Failed to move a storage object", file.id, error);
      return {
        success: false,
        message: error instanceof StorageMoveError
          ? error.message
          : t("admin:storage.messages.failed"),
      };
    }
  });
}

export async function moveFilesBatch(
  lang: string,
  input: unknown,
): Promise<ActionResult<MoveBatchOutcome>> {
  const { t } = await getTranslation(lang);
  return await adminAction(async (session) => {
    if (!input || typeof input !== "object") {
      return { success: false, message: t("admin:storage.messages.invalidInput") };
    }
    const { to, cursor } = input as Record<string, unknown>;
    const start = decodeFileCursor(cursor);
    if (!isStorageProvider(to) || start === null) {
      return { success: false, message: t("admin:storage.messages.invalidInput") };
    }
    const { stores } = await getStorageStores();
    if (!stores.some((store) => store.provider === to)) {
      return { success: false, message: t("admin:storage.messages.notConfigured") };
    }

    try {
      const outcome = await moveStorageObjectsBatch({
        to,
        stores,
        cursor: start ? encodeFileCursor(start) : undefined,
        limits: {
          moves: BATCH_MAX_MOVES,
          scanned: BATCH_MAX_SCANNED,
          milliseconds: BATCH_MILLISECONDS,
        },
        nextPage: async (position): Promise<MovableFile[]> => {
          const after = decodeFileCursor(position);
          const rows = await listFilesForAdminAfter({
            after: after ?? undefined,
            limit: BATCH_PAGE_SIZE,
          });
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            objectKey: row.objectKey,
            size: Number(row.size),
            mimeType: row.mimeType,
            cursor: encodeFileCursor(row),
          }));
        },
        onObjectChanged: (file, outcome) =>
          recordMove({ operatorUserId: session.user.id, file, outcome }),
        stillWanted: async (file) => (await findFileForAdminById({ id: file.id })) !== null,
      });
      return { success: true, data: outcome };
    } catch (error) {
      console.error("Failed to move storage objects in bulk", error);
      return { success: false, message: describeError(error) };
    }
  });
}

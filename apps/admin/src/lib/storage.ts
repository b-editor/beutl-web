import "server-only";
import {
  locateStorageObject,
  resolveStorageStores,
  STORAGE_PROVIDERS,
  type ObjectLocation,
  type StorageMoveLease,
  type StorageProvider,
  type StorageStore,
  type StorageStores,
} from "@beutl/api";
import {
  acquireFileStorageMoveLease,
  existsFileById,
  registerAiStorageCleanup,
  releaseFileStorageMoveLease,
} from "@beutl/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// 管理画面は Web と同じストレージ設定 (BEUTL_R2_BUCKET / BEUTL_S3_*) を持つ。
// getCloudflareContext はリクエストコンテキストでのみ使えるため、呼び出し時に引く。
export async function getStorageStores(): Promise<StorageStores> {
  const { env } = await getCloudflareContext({ async: true });
  return resolveStorageStores(env);
}

export function isStorageProvider(value: unknown): value is StorageProvider {
  return (STORAGE_PROVIDERS as readonly unknown[]).includes(value);
}

export type FileLocation =
  | { kind: "located"; locations: ObjectLocation[] }
  | { kind: "error"; error: string };

const LOCATE_CONCURRENCY = 8;

// 一覧の各行について、どのストアに実体があるかを HEAD で確かめる。
// 1 ページ分 (数十件) を、外部ストアへ同時に投げ過ぎない程度に並列化する。
export async function locateFiles(
  files: readonly { objectKey: string }[],
  stores: readonly StorageStore[],
): Promise<Map<string, FileLocation>> {
  const result = new Map<string, FileLocation>();
  const queue = [...new Set(files.map((file) => file.objectKey))];
  const worker = async () => {
    for (;;) {
      const objectKey = queue.shift();
      if (objectKey === undefined) return;
      try {
        result.set(objectKey, {
          kind: "located",
          locations: await locateStorageObject(objectKey, stores),
        });
      } catch (error) {
        result.set(objectKey, {
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LOCATE_CONCURRENCY, queue.length) }, worker),
  );
  return result;
}

// 移動 1 件が持つ File 行のリース。isolate を跨いだ同時移動を排他し、移動中に
// ファイルが消されていたら、その鍵のオブジェクト削除を耐久的な後始末に載せる
// (行の削除が両ストアを掃除した後に着地したコピーを、後から確実に消すため)。
export function fileStorageMoveLease(file: { id: string; objectKey: string }): StorageMoveLease {
  const leaseToken = crypto.randomUUID();
  return {
    acquire: () => acquireFileStorageMoveLease({ id: file.id, leaseToken }),
    async stillExists() {
      if (await existsFileById({ id: file.id })) return true;
      await registerAiStorageCleanup({
        objectKey: file.objectKey,
        aiJobId: null,
        state: "cleanup",
        notBefore: new Date(),
      }).catch((error) => {
        console.error("Failed to queue cleanup for a copy of a deleted file", file.objectKey, error);
      });
      return false;
    },
    async release() {
      await releaseFileStorageMoveLease({ id: file.id, leaseToken }).catch((error) => {
        console.error("Failed to release a storage move lease; it expires on its own", file.id, error);
      });
    },
  };
}

// 一括移動の走査位置。(createdAt, id) をクライアントが持ち回れる文字列にする。
export function encodeFileCursor(position: { createdAt: Date; id: string }): string {
  return Buffer.from(`${position.createdAt.toISOString()}\n${position.id}`, "utf8")
    .toString("base64url");
}

export function decodeFileCursor(
  value: unknown,
): { createdAt: Date; id: string } | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("\n");
  if (separator === -1) return null;
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isFinite(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

import {
  MAX_GIT_REPOSITORY_THUMBNAIL_BYTES,
  MAX_GIT_REPOSITORY_THUMBNAIL_DIMENSION,
  type GitRepositorySummary,
} from "@beutl/core";
import { getDb } from "@beutl/db";
import { inspectInputPng } from "../ai/image-validation";
import type { GitEnvironment } from "./environment";
import type { GitObjectBucket } from "./git-object-store";
import { gitRepositorySummary, ownsActiveGitRepository } from "./repositories";
import { S3GitObjectBucket } from "./s3-object-store";

export type GitRepositoryThumbnailBucket = Pick<GitObjectBucket, "get" | "head" | "put" | "delete" | "pruneVersions">;

export function gitRepositoryThumbnailPrefix(repoId: string): string {
  return `git-thumbnails/repos/${repoId}/`;
}

export function gitRepositoryThumbnailKey(repoId: string): string {
  return `${gitRepositoryThumbnailPrefix(repoId)}thumbnail.png`;
}

/** Validates raw PNG bytes, structure, and thumbnail dimensions without decoding into a full raster. */
export async function validateGitRepositoryThumbnail(bytes: Uint8Array, signal?: AbortSignal): Promise<boolean> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_GIT_REPOSITORY_THUMBNAIL_BYTES) {
    return false;
  }
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  try {
    const metadata = await inspectInputPng(buffer as ArrayBuffer, signal);
    return metadata.width <= MAX_GIT_REPOSITORY_THUMBNAIL_DIMENSION &&
      metadata.height <= MAX_GIT_REPOSITORY_THUMBNAIL_DIMENSION;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

export async function readGitRepositoryThumbnail(
  env: GitEnvironment,
  ownerId: string,
  repoId: string,
  options: { headOnly?: boolean; bucket?: GitRepositoryThumbnailBucket } = {},
): Promise<{ size: number; body?: ReadableStream<Uint8Array>; updatedAt: Date } | null> {
  const row = await (await getDb()).gitRepository.findFirst({
    where: { id: repoId, ownerId, deletedAt: null },
    select: { thumbnailUpdatedAt: true },
  });
  if (!row?.thumbnailUpdatedAt) return null;

  const bucket = options.bucket ?? new S3GitObjectBucket(env);
  const key = gitRepositoryThumbnailKey(repoId);
  if (options.headOnly) {
    const object = await bucket.head(key);
    return object ? { size: object.size, updatedAt: row.thumbnailUpdatedAt } : null;
  }
  const object = await bucket.get(key);
  return object ? { size: object.size, body: object.body, updatedAt: row.thumbnailUpdatedAt } : null;
}

export async function saveGitRepositoryThumbnail(
  env: GitEnvironment,
  ownerId: string,
  repoId: string,
  bytes: Uint8Array,
  origin: string,
  options: { signal?: AbortSignal; bucket?: GitRepositoryThumbnailBucket } = {},
): Promise<{ status: "updated"; repository: GitRepositorySummary } | { status: "invalid" } | { status: "notFound" }> {
  if (!await ownsActiveGitRepository(ownerId, repoId)) {
    return { status: "notFound" };
  }
  if (!await validateGitRepositoryThumbnail(bytes, options.signal)) {
    return { status: "invalid" };
  }

  const bucket = options.bucket ?? new S3GitObjectBucket(env);
  const key = gitRepositoryThumbnailKey(repoId);
  const putResult = await bucket.put(key, bytes);
  const versionId = typeof putResult === "object" && putResult !== null && "versionId" in putResult &&
    typeof putResult.versionId === "string"
    ? putResult.versionId
    : undefined;

  let row;
  try {
    row = await (await getDb()).gitRepository.update({
      where: { id: repoId, ownerId, deletedAt: null },
      data: { thumbnailUpdatedAt: new Date() },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025") {
      await bucket.delete(key).catch(() => undefined);
      return { status: "notFound" };
    }
    throw error;
  }

  if (versionId) {
    await bucket.pruneVersions?.(key, [versionId]).catch((error) => {
      console.error("Failed to prune old repository thumbnail versions", { repoId, error });
    });
  }

  return { status: "updated", repository: gitRepositorySummary(row, origin) };
}

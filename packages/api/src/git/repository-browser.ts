import {
  byteRangeHeaders,
  parseByteRange,
  type GitCommitPage,
  type GitPathView,
  type GitRefList,
  type GitTreeEntry,
} from "@beutl/core";
import { gitRepositoryObject, type GitAccess, type GitEnvironment } from "./environment";
import type { GitObjectBucket } from "./git-object-store";
import { downloadLfsObject } from "./media-worker";
import { S3GitObjectBucket } from "./s3-object-store";

// The dashboard's view of a repository it already found in the owner's
// account. Every read goes through the repository object's queue.

async function read<T>(response: Response): Promise<T | null> {
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`Git browse request returned HTTP ${response.status}`);
  return await response.json() as T;
}

export async function listRepositoryRefs(env: GitEnvironment, access: GitAccess): Promise<GitRefList> {
  const refs = await read<GitRefList>(await gitRepositoryObject(env, access.repoId).browse(access, "refs"));
  return refs ?? { defaultBranch: null, branches: [], tags: [] };
}

/** Null when the ref or path does not exist. */
export async function readRepositoryPath(env: GitEnvironment, access: GitAccess, ref: string, path: string):
  Promise<GitPathView | null> {
  return read(await gitRepositoryObject(env, access.repoId).browse(access, "path", { ref, path }));
}

/** Null when the ref or cursor does not name a commit. */
export async function listRepositoryCommits(env: GitEnvironment, access: GitAccess, ref: string, cursor?: string):
  Promise<GitCommitPage | null> {
  return read(await gitRepositoryObject(env, access.repoId).browse(access, "log", { ref, ...(cursor ? { cursor } : {}) }));
}

/**
 * A file's bytes at `ref` for GET or HEAD, honoring one byte range. The
 * repository object finds the file and reads an ordinary blob in one request;
 * Git LFS media then streams from its pinned B2 version. Null when there is no
 * such file; the caller adds the type and disposition the dashboard serves it with.
 */
export async function readRepositoryFile(
  env: GitEnvironment, access: GitAccess, request: Request, ref: string, path: string,
  bucket: GitObjectBucket = new S3GitObjectBucket(env),
): Promise<{ entry: GitTreeEntry; response: Response } | null> {
  const repository = gitRepositoryObject(env, access.repoId);
  const file = await repository.browse(access, "file", { ref, path });
  if (!file.ok) {
    await file.body?.cancel();
    if (file.status === 404) return null;
    throw new Error(`Git file request returned HTTP ${file.status}`);
  }
  const entry = JSON.parse(decodeURIComponent(file.headers.get("x-beutl-git-entry") ?? "")) as GitTreeEntry;
  if (entry.lfs) {
    await file.body?.cancel();
    const response = await downloadLfsObject(request, { bucket, repository, access, oid: entry.lfs.oid });
    return { entry, response };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const range = parseByteRange(request.headers.get("range"), bytes.byteLength);
  if (range === "unsatisfiable") {
    return { entry, response: new Response(null, { status: 416, headers: byteRangeHeaders(null, bytes.byteLength) }) };
  }
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  return {
    entry,
    response: new Response(request.method === "HEAD" ? null : body as Uint8Array<ArrayBuffer>, {
      status: range ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        ...(range ? byteRangeHeaders(range, bytes.byteLength) : { "Content-Length": String(bytes.byteLength) }),
      },
    }),
  };
}

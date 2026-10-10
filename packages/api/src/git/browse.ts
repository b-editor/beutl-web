import git from "isomorphic-git";
import { byteRangeHeaders, parseByteRange, type GitCommitPage, type GitCommitSummary, type GitPathView, type GitRefList, type GitTreeEntry } from "@beutl/core";
import { readGitRepository } from "./git-http";
import { readRefs } from "./lfs-references";
import { GitObjectReader } from "./object-reader";
import { knownLengthStream } from "./streams";

// Read-only views of a repository's history for the dashboard. The repository
// object runs them in its queue, so a push or a collection never replaces a
// pack while one is reading it.

type Repository = ReturnType<typeof readGitRepository>;
export const MAX_COMMIT_PAGE = 50;

/** A ref, path or commit that this repository does not have. */
export class GitBrowseNotFoundError extends Error {}

export async function browseRefs({ store, prefix, repo }: Repository): Promise<GitRefList> {
  const gitdir = `${prefix}${repo.gitdir}/`;
  const [refs, head] = await Promise.all([readRefs(store, gitdir), store.get(`${gitdir}HEAD`)]);
  const target = head ? /^ref: refs\/heads\/(.+)$/u.exec(new TextDecoder().decode(head).trim())?.[1] : undefined;
  const named = (kind: string) => [...refs].filter(([name]) => name.startsWith(kind))
    .map(([name, oid]) => ({ name: name.slice(kind.length), oid }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const branches = named("refs/heads/");
  return {
    // A fresh repository's HEAD names a branch that no push has created yet.
    defaultBranch: target && branches.some((branch) => branch.name === target) ? target : branches[0]?.name ?? null,
    branches,
    tags: named("refs/tags/"),
  };
}

/**
 * The commit a revision names; annotated tags are peeled. A short name means
 * a branch before a tag; `refs/tags/…` and `refs/heads/…` name one exactly.
 */
async function resolveCommit(repository: Repository, revision: string, reader: GitObjectReader): Promise<string> {
  const { store, prefix, repo } = repository;
  let oid = /^[0-9a-f]{40}$/u.test(revision) ? revision : undefined;
  if (!oid) {
    const refs = await readRefs(store, `${prefix}${repo.gitdir}/`);
    oid = /^refs\/(heads|tags)\//u.test(revision)
      ? refs.get(revision)
      : refs.get(`refs/heads/${revision}`) ?? refs.get(`refs/tags/${revision}`);
  }
  for (let depth = 0; oid && depth < 8; depth++) {
    const object = await reader.info(oid);
    if (!object) throw new GitBrowseNotFoundError(`No object ${oid}`);
    if (object.type === "commit") return oid;
    if (object.type !== "tag") break;
    oid = /^object ([0-9a-f]{40})\n/u.exec(new TextDecoder().decode(await reader.read(oid)))?.[1];
  }
  throw new GitBrowseNotFoundError(`No commit for ${revision}`);
}

/**
 * A Git LFS pointer's object and size, read as the specification writes one:
 * the version line first, then `oid` and `size`. Collection matches pointers
 * more loosely so it never deletes media; here a text file that only quotes
 * a pointer must still show as text.
 */
function lfsPointer(blob: Uint8Array): GitTreeEntry["lfs"] {
  // Git LFS never reads a blob larger than this as a pointer.
  if (blob.byteLength > 1024) return undefined;
  const lines = new TextDecoder().decode(blob).split("\n").map((line) => line.replace(/\r$/u, ""));
  if (lines[0] !== "version https://git-lfs.github.com/spec/v1") return undefined;
  const oid = lines.find((line) => line.startsWith("oid "))?.match(/^oid sha256:([0-9a-f]{64})$/u)?.[1];
  const size = lines.find((line) => line.startsWith("size "))?.match(/^size (\d+)$/u)?.[1];
  return oid && size && Number.isSafeInteger(Number(size)) ? { oid, size: Number(size) } : undefined;
}

async function describeEntry(blobs: GitObjectReader,
  entry: { path: string; oid: string; type: string }, path: string):
  Promise<GitTreeEntry> {
  const base = { name: entry.path, path, oid: entry.oid };
  // A submodule entry names a commit in another repository.
  if (entry.type === "commit") return { ...base, type: "submodule" };
  if (entry.type === "tree") return { ...base, type: "tree" };
  const size = await blobs.size(entry.oid);
  if (size === null) throw new GitBrowseNotFoundError(`No object ${entry.oid}`);
  // Only pointer-sized blobs need their contents to describe a directory.
  const lfs = size <= 1024 ? lfsPointer(await blobs.read(entry.oid, 1024)) : undefined;
  return { ...base, type: "blob", size, ...(lfs ? { lfs } : {}) };
}

/** What `path` names in the commit `revision` resolves to. */
export async function browsePath(repository: Repository, revision: string, path: string,
  blobs = new GitObjectReader(repository)): Promise<GitPathView> {
  const { repo } = repository;
  const commit = await resolveCommit(repository, revision, blobs);
  let tree = (await git.readCommit({ ...repo, oid: commit })).commit.tree;
  const segments = path === "" ? [] : path.split("/");
  for (const [index, segment] of segments.entries()) {
    const entry = (await git.readTree({ ...repo, oid: tree })).tree.find((item) => item.path === segment);
    if (!entry) throw new GitBrowseNotFoundError(`No ${path} in ${commit}`);
    const entryPath = segments.slice(0, index + 1).join("/");
    if (entry.type === "tree") { tree = entry.oid; continue; }
    if (index !== segments.length - 1) throw new GitBrowseNotFoundError(`No ${path} in ${commit}`);
    return { kind: "blob", commit, path, entry: await describeEntry(blobs, entry, entryPath) };
  }
  const entries: GitTreeEntry[] = [];
  for (const entry of (await git.readTree({ ...repo, oid: tree })).tree) {
    entries.push(await describeEntry(blobs, entry, path === "" ? entry.path : `${path}/${entry.path}`));
  }
  // Directories first, then files, each by name as people sort them.
  const order = { tree: 0, submodule: 1, blob: 2 };
  entries.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { kind: "tree", commit, path, entries };
}

/** First-parent history from `revision`, or from `cursor` to continue a page. */
export async function browseLog(repository: Repository, revision: string, cursor: string | undefined, limit: number):
  Promise<GitCommitPage> {
  const { repo } = repository;
  const reader = new GitObjectReader(repository);
  let oid: string | undefined = cursor ?? await resolveCommit(repository, revision, reader);
  const commits: GitCommitSummary[] = [];
  while (oid && commits.length < limit) {
    if ((await reader.info(oid))?.type !== "commit") throw new GitBrowseNotFoundError(`No commit ${oid}`);
    const { commit } = await git.readCommit({ ...repo, oid });
    commits.push({
      oid, message: commit.message, authorName: commit.author.name, authorEmail: commit.author.email,
      authoredAt: new Date(commit.author.timestamp * 1000).toISOString(), parents: commit.parent,
    });
    oid = commit.parent[0];
  }
  return { commits, next: oid ?? null };
}

/**
 * One file at a commit. Compressed inputs are pinned in the repository queue;
 * the response expands only the requested bytes as the consumer reads them.
 */
export async function browseFile(repository: Repository, revision: string, path: string,
  request: { method?: string; range?: string | null } = {}): Promise<{ entry: GitTreeEntry; response: Response }> {
  const reader = new GitObjectReader(repository);
  const view = await browsePath(repository, revision, path, reader);
  if (view.kind !== "blob" || view.entry.type !== "blob") throw new GitBrowseNotFoundError(`No file ${path}`);
  const entry = view.entry;
  if (entry.lfs) return { entry, response: new Response(null) };
  const size = entry.size!, range = parseByteRange(request.range ?? null, size);
  if (range === "unsatisfiable")
    return { entry, response: new Response(null, { status: 416, headers: byteRangeHeaders(null, size) }) };
  const length = range ? range.end - range.start + 1 : size;
  const body = request.method === "HEAD" ? null : knownLengthStream(await reader.stream(entry.oid,
    range ? { offset: range.start, length } : undefined), length);
  return { entry, response: new Response(body, { status: range ? 206 : 200, headers: {
    "Accept-Ranges": "bytes", ...(range ? byteRangeHeaders(range, size) : { "Content-Length": String(size) }),
  } }) };
}

export const GIT_REPOSITORY_LIMIT = 20;
export const GIT_REPOSITORY_NAME_MAX_LENGTH = 80;

export function isValidGitRepositoryName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= GIT_REPOSITORY_NAME_MAX_LENGTH && !/[\p{Cc}/\\]/u.test(value);
}

export function isGitRepositoryId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

export type GitRepositorySummary = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export const GIT_ACCESS_TOKEN_LIMIT = 50;
export const GIT_ACCESS_TOKEN_NAME_MAX_LENGTH = 80;
export type GitAccessTokenScope = "read" | "write";

export function isValidGitAccessTokenName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= GIT_ACCESS_TOKEN_NAME_MAX_LENGTH && !/\p{Cc}/u.test(value);
}

/** A token as the dashboard and API list it; the secret itself is shown only once. */
export type GitAccessTokenSummary = {
  id: string;
  name: string;
  scope: GitAccessTokenScope;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type CreatedGitAccessToken = GitAccessTokenSummary & { token: string };

/** The branches and tags of a repository, and the branch its HEAD names. */
export type GitRef = { name: string; oid: string };
export type GitRefList = { defaultBranch: string | null; branches: GitRef[]; tags: GitRef[] };

/** One entry of a directory in a commit's tree. */
export type GitTreeEntry = {
  name: string;
  path: string;
  type: "tree" | "blob" | "submodule";
  oid: string;
  /** Bytes of a blob as Git stores it; a Git LFS pointer's media size is in `lfs`. */
  size?: number;
  /** Set when the blob is a Git LFS pointer. */
  lfs?: { oid: string; size: number };
};

/** What a path names in a commit: a directory and its entries, or one file. */
export type GitPathView =
  | { kind: "tree"; commit: string; path: string; entries: GitTreeEntry[] }
  | { kind: "blob"; commit: string; path: string; entry: GitTreeEntry };

export type GitCommitSummary = {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  parents: string[];
};

/** A page of first-parent history; `next` continues it. */
export type GitCommitPage = { commits: GitCommitSummary[]; next: string | null };

/** A branch, a tag or a full commit ID, as the dashboard names a version. */
export function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    !/[\p{Cc}\s~^:?*[\\]|\.\.|^\/|\/$|\.lock$|@\{/u.test(value);
}

/** A path inside a repository: no empty, `.` or `..` segments. */
export function isGitTreePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && !/\p{Cc}/u.test(value) &&
    (value === "" || value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
}

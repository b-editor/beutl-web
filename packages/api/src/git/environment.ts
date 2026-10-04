import type { GitS3Environment } from "./s3-object-store";
import type { GitScope } from "./tokens";

interface GitRepositoryNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** Worker bindings used by Hosted Git. Storage shares the File/AI BEUTL_S3_* settings. */
export interface GitEnvironment extends GitS3Environment {
  BEUTL_GIT_ENABLED?: string;
  BEUTL_GIT_TOKEN_SECRET?: string;
  BEUTL_GIT_REPOSITORIES?: GitRepositoryNamespace;
  PUBLIC_ORIGIN?: string;
}

/** The identity a Worker route verified before it reaches the repository object. */
export type GitAccess = { repoId: string; ownerId: string; scope: GitScope };

export type GitMediaAction = "create" | "part" | "accept" | "cancel" | "complete" | "checkpoint";

/** Cron cleanup needs only storage, so it keeps running while the API is disabled. */
export function gitStorageConfigured(env: GitEnvironment | undefined): boolean {
  return !!env?.BEUTL_GIT_REPOSITORIES && !!env.BEUTL_S3_ENDPOINT && !!env.BEUTL_S3_REGION &&
    !!env.BEUTL_S3_BUCKET && !!env.BEUTL_S3_ACCESS_KEY_ID && !!env.BEUTL_S3_SECRET_ACCESS_KEY;
}

export function gitAvailability(env: GitEnvironment | undefined): "disabled" | "unconfigured" | "ready" {
  if (env?.BEUTL_GIT_ENABLED !== "true") return "disabled";
  return gitStorageConfigured(env) && env.BEUTL_GIT_TOKEN_SECRET ? "ready" : "unconfigured";
}

export function gitPublicOrigin(env: GitEnvironment, fallbackUrl: string): string {
  return new URL(env.PUBLIC_ORIGIN || fallbackUrl).origin;
}

// Requests to the object never leave Cloudflare; this host only names the internal API.
const INTERNAL_ORIGIN = "https://git.internal";

function accessHeaders(headers: HeadersInit | undefined, access: GitAccess): Headers {
  const result = new Headers(headers);
  result.set("x-beutl-repo-id", access.repoId);
  result.set("x-beutl-git-scope", access.scope);
  result.set("x-beutl-git-owner-id", access.ownerId);
  return result;
}

/** Client for the repository Durable Object's internal HTTP API. */
export function gitRepositoryObject(env: GitEnvironment, repoId: string) {
  const namespace = env.BEUTL_GIT_REPOSITORIES;
  if (!namespace) throw new Error("Git Durable Object binding is missing");
  const stub = namespace.get(namespace.idFromName(repoId));
  const admin = (method: string, path: string) => stub.fetch(new Request(`${INTERNAL_ORIGIN}/internal/git/${path}`, {
    method, headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "admin" },
  }));
  return {
    /** 204 when storage is gone; 202 while the final multipart abort waits for its grace period. */
    cleanup: () => admin("DELETE", "cleanup"),
    settleHistory: () => admin("POST", "history"),
    cleanupLfs: (oid: string) => admin("POST", `lfs-cleanup/${oid}`),
    /** Git smart HTTP and LFS batch keep their public URL, body stream and abort signal. */
    forward: (request: Request, access: GitAccess) =>
      stub.fetch(new Request(request, { headers: accessHeaders(request.headers, access) })),
    /** LFS bodies stay in the Worker; the object only records reservations and receipts. */
    media: (access: GitAccess, oid: string, action: "status" | GitMediaAction, body?: unknown) =>
      stub.fetch(new Request(`${INTERNAL_ORIGIN}/internal/git/media/${oid}/${action}`, {
        method: action === "status" ? "GET" : "POST",
        headers: accessHeaders({ "Content-Type": "application/json" }, access),
        ...(action === "status" ? {} : { body: JSON.stringify(body) }),
      })),
  };
}

export type GitRepositoryObject = ReturnType<typeof gitRepositoryObject>;

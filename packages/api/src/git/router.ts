import { getDb, createGitRepositoryForOwner } from "@beutl/db";
import { listExpiredGitLfsReservations } from "@beutl/db";
import { getUserIdFromHeaders } from "../api/auth";
import { gitTokenSecret, issueGitToken, verifyGitToken, verifyMultipartToken, type GitScope } from "./tokens";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REPO_PATH = /^\/api\/v3\/repos\/([0-9a-f-]{36})(?:\/(token))?$/u;
const GIT_PATH = /^\/api\/v3\/git\/([0-9a-f-]{36})\.git\/(.+)$/u;
const MAX_REPOSITORIES_PER_USER = 20;
// A Basic LFS PUT URL can remain usable for an hour after a repository is
// deleted. Sweep again after that window so a late direct B2 PUT cannot leave
// an orphaned object under a completed tombstone.
export const GIT_DELETE_SWEEP_GRACE_MS = 2 * 60 * 60 * 1000;

export interface GitRepositoryNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface GitRouterEnvironment {
  BEUTL_GIT_ENABLED?: string;
  BEUTL_GIT_TOKEN_SECRET?: string;
  BEUTL_GIT_REPOSITORIES?: GitRepositoryNamespace;
  BEUTL_GIT_S3_ENDPOINT?: string;
  BEUTL_GIT_S3_REGION?: string;
  BEUTL_GIT_S3_BUCKET?: string;
  BEUTL_GIT_S3_ACCESS_KEY_ID?: string;
  BEUTL_GIT_S3_SECRET_ACCESS_KEY?: string;
  BEUTL_GIT_S3_PATH_STYLE?: string;
  PUBLIC_ORIGIN?: string;
}

const noStore = { "Cache-Control": "no-store" };
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

function enabled(env: GitRouterEnvironment): boolean {
  return env.BEUTL_GIT_ENABLED === "true";
}

function storageUnavailable(env: GitRouterEnvironment): boolean {
  return !env.BEUTL_GIT_REPOSITORIES ||
    !env.BEUTL_GIT_S3_ENDPOINT || !env.BEUTL_GIT_S3_REGION || !env.BEUTL_GIT_S3_BUCKET ||
    !env.BEUTL_GIT_S3_ACCESS_KEY_ID || !env.BEUTL_GIT_S3_SECRET_ACCESS_KEY;
}

function stub(env: GitRouterEnvironment, repoId: string) {
  const namespace = env.BEUTL_GIT_REPOSITORIES;
  if (!namespace) throw new Error("Git Durable Object binding is missing");
  return namespace.get(namespace.idFromName(repoId));
}

function repoUrl(env: GitRouterEnvironment, request: Request, repoId: string): string {
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : new URL(request.url).origin;
  return `${origin}/api/v3/git/${repoId}.git`;
}

function view(repo: { id: string; name: string; createdAt: Date; updatedAt: Date }, url: string) {
  return { id: repo.id, name: repo.name, url, createdAt: repo.createdAt, updatedAt: repo.updatedAt };
}

async function cleanup(env: GitRouterEnvironment, repoId: string): Promise<boolean> {
  const headers = new Headers({ "x-beutl-repo-id": repoId, "x-beutl-git-scope": "admin" });
  const result = await stub(env, repoId).fetch(new Request("https://git.internal/internal/git/cleanup", {
    method: "DELETE", headers,
  }));
  return result.status === 204;
}

export async function reconcileGitRepositoryDeletions(env: GitRouterEnvironment): Promise<number> {
  if (storageUnavailable(env)) return 0;
  const db = await getDb();
  const tombstones = await db.gitRepository.findMany({
    where: {
      OR: [{ deletedAt: { not: null } }, { ownerId: null }],
      cleanupCompleteAt: null,
    },
    select: { id: true, deletedAt: true, maintenanceFailures: true },
    orderBy: [{ maintenanceAttemptedAt: "asc" }, { id: "asc" }], take: 10,
  });
  let cleaned = 0;
  for (const row of tombstones) {
    try {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceAttemptedAt: new Date() } });
      const deletedAt = row.deletedAt ?? new Date();
      if (!row.deletedAt) {
        await db.gitRepository.update({ where: { id: row.id }, data: { deletedAt } });
      }
      if (await cleanup(env, row.id)) {
        if (Date.now() - deletedAt.getTime() >= GIT_DELETE_SWEEP_GRACE_MS) {
          await db.gitRepository.update({
            where: { id: row.id }, data: { cleanupCompleteAt: new Date(), maintenanceFailures: 0 },
          });
        }
        cleaned++;
      } else {
        throw new Error("Git repository cleanup did not complete");
      }
    } catch (error) {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceFailures: { increment: 1 } } })
        .catch((failureError) => console.error("Failed to record Git cleanup failure", { repoId: row.id, error: failureError }));
      console.error("Git repository cleanup failed", { repoId: row.id, error,
        failures: row.maintenanceFailures + 1, interventionRequired: row.maintenanceFailures >= 4 });
    }
  }
  return cleaned;
}

// Run after the schema migration, before enabling hosted Git. Existing DO
// records are adopted without discarding uploads or forcing users under a
// newly introduced limit. Account admission remains blocked until adopted.
export async function reconcileGitAccountStorage(env: GitRouterEnvironment): Promise<number> {
  if (storageUnavailable(env)) return 0;
  const db = await getDb();
  const rows = await db.gitRepository.findMany({
    where: { OR: [{ accountedAt: null }, { historyReservedBytes: { gt: 0 } }],
      deletedAt: null, ownerId: { not: null } },
    select: { id: true, ownerId: true, maintenanceFailures: true },
    orderBy: [{ maintenanceAttemptedAt: "asc" }, { id: "asc" }], take: 10,
  });
  let completed = 0;
  for (const row of rows) {
    try {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceAttemptedAt: new Date() } });
      const result = await stub(env, row.id).fetch(new Request("https://git.internal/internal/git/accounting", {
        method: "POST", headers: { "x-beutl-repo-id": row.id, "x-beutl-git-scope": "admin",
          "x-beutl-git-owner-id": row.ownerId! },
      }));
      if (result.status !== 204 && result.status !== 202) throw new Error(`Git account storage reconciliation returned HTTP ${result.status}`);
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceFailures: 0 } });
      if (result.status === 202) continue; // The persisted adoption cursor advances on the next scheduled run.
      completed++;
    } catch (error) {
      await db.gitRepository.update({ where: { id: row.id }, data: { maintenanceFailures: { increment: 1 } } })
        .catch((failureError) => console.error("Failed to record Git reconciliation failure", { repoId: row.id, error: failureError }));
      console.error("Git account storage reconciliation failed", { repoId: row.id, error,
        failures: row.maintenanceFailures + 1, interventionRequired: row.maintenanceFailures >= 4 });
    }
  }
  return completed;
}

export async function reconcileGitLfsReservations(env: GitRouterEnvironment): Promise<number> {
  if (storageUnavailable(env)) return 0;
  const db = await getDb();
  const rows = await listExpiredGitLfsReservations(new Date(), 20, db);
  let completed = 0;
  for (const row of rows) {
    try {
      await db.gitLfsStorage.updateMany({ where: { repoId: row.repoId, oid: row.oid },
        data: { cleanupAttemptedAt: new Date() } });
      const result = await stub(env, row.repoId).fetch(new Request(
        `https://git.internal/internal/git/lfs-cleanup/${row.oid}`, {
          method: "POST", headers: { "x-beutl-repo-id": row.repoId, "x-beutl-git-scope": "admin" },
        }));
      if (result.status !== 204) throw new Error(`Git LFS reservation cleanup returned HTTP ${result.status}`);
      await db.gitLfsStorage.updateMany({ where: { repoId: row.repoId, oid: row.oid }, data: { cleanupFailures: 0 } });
      completed++;
    } catch (error) {
      await db.gitLfsStorage.updateMany({ where: { repoId: row.repoId, oid: row.oid },
        data: { cleanupFailures: { increment: 1 } } }).catch((failureError) => console.error("Failed to record LFS cleanup failure", { repoId: row.repoId, oid: row.oid, error: failureError }));
      console.error("Git LFS reservation cleanup failed", { repoId: row.repoId, oid: row.oid, error,
        failures: row.cleanupFailures + 1, interventionRequired: row.cleanupFailures >= 4 });
    }
  }
  return completed;
}

/** Worker-only route: API JWT manages repos, dedicated Git JWT carries Git traffic. */
export async function routeGitRequest(request: Request, env: GitRouterEnvironment): Promise<Response | null> {
  const response = await routeGitRequestCore(request, env);
  return response ? withTusProtocolHeader(request, response) : null;
}

export function withTusProtocolHeader(request: Request, response: Response): Response {
  if (!/^\/api\/v3\/git\/[0-9a-f-]+\.git\/info\/lfs\/objects\/[0-9a-f]{64}\/tus(?:\/[^/]*)?$/u
    .test(new URL(request.url).pathname) || response.headers.get("Tus-Resumable") === "1.0.0") {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Tus-Resumable", "1.0.0");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function routeGitRequestCore(request: Request, env: GitRouterEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const isCollection = path === "/api/v3/repos";
  const repoMatch = REPO_PATH.exec(path);
  const gitMatch = GIT_PATH.exec(path);
  if (!isCollection && !repoMatch && !gitMatch) return null;
  if (!enabled(env)) return new Response("Not found", { status: 404 });
  if (storageUnavailable(env) || !env.BEUTL_GIT_TOKEN_SECRET)
    return json({ message: "Hosted Git is not configured" }, 503);
  const secret = gitTokenSecret(env);
  const db = await getDb();

  if (gitMatch) {
    const repoId = gitMatch[1];
    if (!UUID.test(repoId)) return new Response("Not found", { status: 404 });
    const requiredScope: GitScope = gitMatch[2] === "git-receive-pack" ||
      (gitMatch[2] === "info/refs" && url.searchParams.get("service") === "git-receive-pack") ||
      (gitMatch[2] === "info/lfs/objects/batch" && request.method === "POST") ||
      gitMatch[2].endsWith("/verify") ? "write" : "read";
    // LFS batch may ask for download, so validate the read token here and
    // leave its upload operation check to the Durable Object.
    const multipartPath = /^info\/lfs\/objects\/([0-9a-f]{64})\/multipart(?:\/.*)?$/u.exec(gitMatch[2]);
    const tusPath = /^info\/lfs\/objects\/([0-9a-f]{64})\/tus(?:\/.*)?$/u.exec(gitMatch[2]);
    const verifyPath = /^info\/lfs\/objects\/([0-9a-f]{64})\/verify$/u.exec(gitMatch[2]);
    const session = multipartPath || tusPath || verifyPath
      ? await verifyMultipartToken(secret, request.headers.get("authorization"),
          repoId, (multipartPath ?? tusPath ?? verifyPath)![1])
      : null;
    const gitAuthenticated = await verifyGitToken(
      secret, request.headers.get("authorization"), repoId,
      gitMatch[2] === "info/lfs/objects/batch" ? "read" : requiredScope,
    );
    const authenticated = session
      ? { ownerId: session.ownerId, scope: "write" as const }
      : gitAuthenticated;
    if (!authenticated) return new Response("Unauthorized", {
      status: 401, headers: { "WWW-Authenticate": "Bearer realm=\"Beutl Git\"", ...noStore },
    });
    const repo = await db.gitRepository.findFirst({
      where: { id: repoId, ownerId: authenticated.ownerId, deletedAt: null }, select: { id: true, accountedAt: true },
    });
    if (!repo) return new Response("Not found", { status: 404 });
    if (repo.accountedAt === null) return new Response("Git account storage reconciliation is pending", { status: 503 });
    const headers = new Headers(request.headers);
    headers.set("x-beutl-repo-id", repoId);
    headers.set("x-beutl-git-scope", authenticated.scope);
    headers.set("x-beutl-git-owner-id", authenticated.ownerId);
    const forwarded = new Request(request, { headers });
    return stub(env, repoId).fetch(forwarded);
  }

  const userId = await getUserIdFromHeaders(request.headers);
  if (!userId) return json({ message: "Authentication is required" }, 401);

  if (isCollection && request.method === "GET") {
    const rows = await db.gitRepository.findMany({
      where: { ownerId: userId, deletedAt: null },
      orderBy: { createdAt: "desc" }, take: MAX_REPOSITORIES_PER_USER,
    });
    return json({ repositories: rows.map((row) => view(row, repoUrl(env, request, row.id))) });
  }
  if (isCollection && request.method === "POST") {
    let input: unknown;
    try { input = await request.json(); } catch {
      // Invalid request JSON is reported to the caller as HTTP 400.
      return json({ message: "Invalid JSON" }, 400);
    }
    const name = (input as { name?: unknown } | null)?.name;
    const creationId = (input as { creationId?: unknown } | null)?.creationId;
    const requestedOwner = (input as { ownerId?: unknown } | null)?.ownerId;
    if (typeof name !== "string" || name.trim().length < 1 || name.length > 80 ||
        /[\x00-\x1f\x7f/\\]/u.test(name)) {
      return json({ message: "Invalid repository name" }, 400);
    }
    if (creationId !== undefined && (typeof creationId !== "string" || !UUID.test(creationId) || creationId === "00000000-0000-0000-0000-000000000000")) {
      return json({ message: "Invalid repository creation identifier" }, 400);
    }
    if (requestedOwner !== undefined && requestedOwner !== userId) {
      return json({ message: "The authenticated account changed; retry with the original account" }, 409);
    }
    try {
      const row = await createGitRepositoryForOwner(userId, name.trim(), MAX_REPOSITORIES_PER_USER, db, creationId);
      if (!row) return json({ message: "Repository limit reached" }, 409);
      return json(view(row, repoUrl(env, request, row.id)), 201);
    } catch (error) {
      if (error instanceof Error && error.message === "Repository creation identifier is already used" ||
          typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        return json({ message: "Repository creation identifier conflicts with an existing repository" }, 409);
      }
      throw error;
    }
  }
  if (!repoMatch || !UUID.test(repoMatch[1])) return new Response("Not found", { status: 404 });
  const repoId = repoMatch[1];
  const row = await db.gitRepository.findFirst({ where: { id: repoId, ownerId: userId, deletedAt: null } });
  if (!row) return new Response("Not found", { status: 404 });
  if (!repoMatch[2] && request.method === "GET") return json(view(row, repoUrl(env, request, repoId)));
  if (repoMatch[2] === "token" && request.method === "POST") {
    let input: unknown;
    try { input = await request.json(); } catch {
      // Invalid request JSON is reported to the caller as HTTP 400.
      return json({ message: "Invalid JSON" }, 400);
    }
    const scope = (input as { scope?: unknown } | null)?.scope;
    if (scope !== "read" && scope !== "write") return json({ message: "Invalid Git scope" }, 400);
    return json(await issueGitToken(secret, userId, repoId, scope));
  }
  if (!repoMatch[2] && request.method === "DELETE") {
    await db.gitRepository.update({ where: { id: repoId }, data: { deletedAt: new Date() } });
    try {
      await cleanup(env, repoId);
    } catch (error) {
      console.error("Git repository cleanup deferred", { repoId, error });
    }
    return new Response(null, { status: 204 });
  }
  return new Response("Method not allowed", { status: 405 });
}

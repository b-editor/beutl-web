import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { findGitAccess } from "../git/access-tokens";
import { gitAvailability, gitRepositoryObject, type GitAccess, type GitEnvironment } from "../git/environment";
import { S3GitObjectBucket } from "../git/s3-object-store";
import type { GitScope } from "../git/tokens";
import {
  appendTusUpload,
  createTusUpload,
  downloadLfsObject,
  readTusUpload,
  tusOptions,
  verifyLfsUpload,
  type LfsObject,
} from "../git/media-worker";

type Routes = { Bindings: GitEnvironment; Variables: { access: GitAccess } };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REPOSITORY = `/:repo{${UUID}\\.git}`;
const LFS_OBJECT = `${REPOSITORY}/info/lfs/objects/:oid{[0-9a-f]{64}}`;
const TUS_UPLOAD = `${LFS_OBJECT}/tus/:resource{${UUID}}`;

/** Hosted Git is opt-in per environment and needs its storage and object binding. */
export const requireHostedGit = createMiddleware<{ Bindings: GitEnvironment }>(async (c, next) => {
  const availability = gitAvailability(c.env);
  if (availability === "disabled") return c.text("Not found", 404);
  if (availability === "unconfigured") {
    return c.json({ message: "Hosted Git is not configured" }, 503, { "Cache-Control": "no-store" });
  }
  await next();
});

const repositoryId = (c: Context) => c.req.param("repo")!.slice(0, -".git".length);

/**
 * Git and Git LFS authenticate with a repository access token, sent as
 * `https://USER:TOKEN@host/...` (Basic) or as a Bearer credential.
 */
const authorize = (scope: GitScope | ((c: Context<Routes>) => GitScope)) => createMiddleware<Routes>(async (c, next) => {
  const repoId = repositoryId(c);
  const access = await findGitAccess(c.req.header("authorization") ?? null, repoId);
  if (!access) {
    // A Basic challenge makes Git send the credentials embedded in the remote URL.
    return c.text("Unauthorized", 401, { "WWW-Authenticate": "Basic realm=\"Beutl Git\", charset=\"UTF-8\"", "Cache-Control": "no-store" });
  }
  if (!access.active) return c.text("Not found", 404);
  const required = typeof scope === "function" ? scope(c) : scope;
  if (required === "write" && access.scope !== "write") return c.text("This token is read-only", 403, { "Cache-Control": "no-store" });
  c.set("access", { repoId, ownerId: access.ownerId, scope: access.scope });
  await next();
});

const tusVersion = createMiddleware(async (c, next) => {
  if (c.req.header("tus-resumable") !== "1.0.0") {
    return c.body(null, 412, { "Tus-Version": "1.0.0", "Cache-Control": "no-store" });
  }
  await next();
});

/** Smart HTTP and LFS batch metadata are serialized by the repository's Durable Object. */
const forward = (c: Context<Routes>) => gitRepositoryObject(c.env, c.get("access").repoId).forward(c.req.raw, c.get("access"));

const lfsObject = (c: Context<Routes>): LfsObject => ({
  bucket: new S3GitObjectBucket(c.env),
  repository: gitRepositoryObject(c.env, c.get("access").repoId),
  access: c.get("access"),
  oid: c.req.param("oid")!,
});

// Paths follow Git smart HTTP and Git LFS so stock clients use the clone URL.
const git = new Hono<Routes>()
  // tus clients require the protocol header on every response, including errors.
  .use(`${LFS_OBJECT}/tus/*`, async (c, next) => {
    await next();
    c.header("Tus-Resumable", "1.0.0");
  })
  .use(requireHostedGit)
  .get(`${REPOSITORY}/info/refs`,
    authorize((c) => c.req.query("service") === "git-receive-pack" ? "write" : "read"), forward)
  .post(`${REPOSITORY}/git-upload-pack`, authorize("read"), forward)
  .post(`${REPOSITORY}/git-receive-pack`, authorize("write"), forward)
  // A batch may only download; the object rejects an upload batch without write scope.
  .post(`${REPOSITORY}/info/lfs/objects/batch`, authorize("read"), forward)
  .get(`${LFS_OBJECT}/download`, authorize("read"), (c) => downloadLfsObject(c.req.raw, lfsObject(c)))
  // File locking is not offered. 501, unlike 404, makes Git LFS stop checking on every push.
  .post(`${REPOSITORY}/info/lfs/locks/verify`, authorize("read"), (c) =>
    c.json({ message: "Git LFS file locking is not supported" }, 501,
      { "Content-Type": "application/vnd.git-lfs+json", "Cache-Control": "no-store" }))
  // Stock Git LFS PUTs to a presigned B2 URL from the batch, then confirms here.
  .post(`${LFS_OBJECT}/verify`, authorize("write"), (c) => verifyLfsUpload(c.req.raw, lfsObject(c)))
  .options(`${LFS_OBJECT}/tus/:resource{${UUID}}?`, authorize("write"), () => tusOptions())
  .post(`${LFS_OBJECT}/tus`, authorize("write"), tusVersion, (c) => createTusUpload(c.req.raw, lfsObject(c)))
  // Hono serves HEAD through GET routes; a tus resource has no GET representation.
  .get(TUS_UPLOAD, authorize("write"), tusVersion, (c) => c.req.method === "HEAD"
    ? readTusUpload(c.req.raw, lfsObject(c), c.req.param("resource"))
    : c.body(null, 405, { "Cache-Control": "no-store" }))
  .patch(TUS_UPLOAD, authorize("write"), tusVersion, (c) =>
    appendTusUpload(c.req.raw, lfsObject(c), c.req.param("resource")));

export default git;

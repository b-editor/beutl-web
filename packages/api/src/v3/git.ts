import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { gitAvailability, gitRepositoryObject, type GitAccess, type GitEnvironment } from "../git/environment";
import { ownsActiveGitRepository } from "../git/repositories";
import { S3GitObjectBucket } from "../git/s3-object-store";
import { gitTokenSecret, verifyGitToken, verifyUploadToken, type GitScope } from "../git/tokens";
import {
  appendTusUpload,
  createTusUpload,
  downloadLfsObject,
  readTusUpload,
  tusOptions,
  type LfsObject,
} from "../git/media-worker";

type Routes = { Bindings: GitEnvironment; Variables: { access: GitAccess } };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REPOSITORY = `/:repo{${UUID}\\.git}`;
const LFS_OBJECT = `${REPOSITORY}/info/lfs/objects/:oid{[0-9a-f]{64}}`;
const TUS_UPLOAD = `${LFS_OBJECT}/tus/:resource{${UUID}}`;

/** Hosted Git is opt-in per environment and needs its storage, object binding and token secret. */
export const requireHostedGit = createMiddleware<{ Bindings: GitEnvironment }>(async (c, next) => {
  const availability = gitAvailability(c.env);
  if (availability === "disabled") return c.text("Not found", 404);
  if (availability === "unconfigured") {
    return c.json({ message: "Hosted Git is not configured" }, 503, { "Cache-Control": "no-store" });
  }
  await next();
});

const repositoryId = (c: Context) => c.req.param("repo")!.slice(0, -".git".length);

async function grant(c: Context<Routes>, identity: { ownerId: string; scope: GitScope } | null, next: () => Promise<void>) {
  if (!identity) {
    return c.text("Unauthorized", 401, { "WWW-Authenticate": "Bearer realm=\"Beutl Git\"", "Cache-Control": "no-store" });
  }
  const repoId = repositoryId(c);
  if (!await ownsActiveGitRepository(identity.ownerId, repoId)) return c.text("Not found", 404);
  c.set("access", { repoId, ...identity });
  await next();
}

/** Git clients present the repository-scoped token issued by POST /repos/:id/token. */
const authorize = (scope: GitScope | ((c: Context<Routes>) => GitScope)) => createMiddleware<Routes>(async (c, next) =>
  grant(c, await verifyGitToken(gitTokenSecret(c.env), c.req.header("authorization") ?? null,
    repositoryId(c), typeof scope === "function" ? scope(c) : scope), next));

/** tus also accepts the OID-scoped upload token returned by the LFS batch response. */
const authorizeUpload = createMiddleware<Routes>(async (c, next) => {
  const secret = gitTokenSecret(c.env);
  const authorization = c.req.header("authorization") ?? null;
  const upload = await verifyUploadToken(secret, authorization, repositoryId(c), c.req.param("oid")!);
  return grant(c, upload
    ? { ownerId: upload.ownerId, scope: "write" }
    : await verifyGitToken(secret, authorization, repositoryId(c), "write"), next);
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
  .options(`${LFS_OBJECT}/tus/:resource{${UUID}}?`, authorizeUpload, () => tusOptions())
  .post(`${LFS_OBJECT}/tus`, authorizeUpload, tusVersion, (c) => createTusUpload(c.req.raw, lfsObject(c)))
  // Hono serves HEAD through GET routes; a tus resource has no GET representation.
  .get(TUS_UPLOAD, authorizeUpload, tusVersion, (c) => c.req.method === "HEAD"
    ? readTusUpload(c.req.raw, lfsObject(c), c.req.param("resource"))
    : c.body(null, 405, { "Cache-Control": "no-store" }))
  .patch(TUS_UPLOAD, authorizeUpload, tusVersion, (c) =>
    appendTusUpload(c.req.raw, lfsObject(c), c.req.param("resource")));

export default git;

import { Hono, type Context } from "hono";
import {
  boundedBody,
  isGitRepositoryId,
  isValidGitAccessTokenName,
  isValidGitRepositoryName,
  MAX_GIT_REPOSITORY_THUMBNAIL_BYTES,
  RequestBodyLimitExceededError,
} from "@beutl/core";
import { getUserId } from "../api/auth";
import { createGitAccessToken, listGitAccessTokens, revokeGitAccessToken } from "../git/access-tokens";
import { gitPublicOrigin, type GitEnvironment } from "../git/environment";
import {
  createGitRepository,
  deleteGitRepository,
  findGitRepository,
  listGitRepositories,
  ownsActiveGitRepository,
  renameGitRepository,
} from "../git/repositories";
import { readGitRepositoryThumbnail, saveGitRepositoryThumbnail } from "../git/thumbnails";
import { requireHostedGit } from "./git";

type Routes = { Bindings: GitEnvironment; Variables: { ownerId: string } };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REPOSITORY = `/:id{${UUID}}`;

async function jsonInput(c: Context): Promise<Record<string, unknown> | null | undefined> {
  try { return await c.req.json(); } catch {
    // A body that is not JSON is the caller's input error, reported as 400.
    return undefined;
  }
}
const message = (c: Context, text: string, status: 400 | 401 | 409 | 413) => c.json({ message: text }, status);
const origin = (c: Context<Routes>) => gitPublicOrigin(c.env, c.req.url);
const THUMBNAIL_HEADERS = {
  "Content-Type": "image/png",
  "Content-Disposition": "inline; filename=\"thumbnail.png\"; filename*=UTF-8''thumbnail.png",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  Vary: "Authorization",
} as const;

function isPngContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0].trim().toLowerCase() === "image/png";
}

async function readBoundedBytes(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = boundedBody(body, limit).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Desktop clients manage repositories with their API JWT. Git traffic itself
// uses the repository access tokens issued here (see ./git).
const repos = new Hono<Routes>()
  .use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Authorization");
    await next();
  })
  .use(requireHostedGit)
  .use(async (c, next) => {
    const ownerId = await getUserId(c);
    if (!ownerId) return message(c, "Authentication is required", 401);
    c.set("ownerId", ownerId);
    await next();
  })
  .get("/", async (c) =>
    c.json({ repositories: await listGitRepositories(c.get("ownerId"), origin(c)) }))
  .post("/", async (c) => {
    const input = await jsonInput(c);
    if (input === undefined) return message(c, "Invalid JSON", 400);
    const ownerId = c.get("ownerId");
    const { name, creationId, ownerId: expectedOwnerId } = input ?? {};
    if (!isValidGitRepositoryName(name)) return message(c, "Invalid repository name", 400);
    if (creationId !== undefined && !isGitRepositoryId(creationId)) {
      return message(c, "Invalid repository creation identifier", 400);
    }
    // A retry signed in as another account must not create under that account.
    if (expectedOwnerId !== undefined && expectedOwnerId !== ownerId) {
      return message(c, "The authenticated account changed; retry with the original account", 409);
    }
    const result = await createGitRepository(ownerId, name.trim(), creationId, origin(c));
    if (result.status === "limitReached") return message(c, "Repository limit reached", 409);
    if (result.status === "conflict") return message(c, "Repository creation identifier conflicts with an existing repository", 409);
    return c.json(result.repository, 201);
  })
  .get(REPOSITORY, async (c) => {
    const repository = await findGitRepository(c.get("ownerId"), c.req.param("id"), origin(c));
    return repository ? c.json(repository) : c.text("Not found", 404);
  })
  .patch(REPOSITORY, async (c) => {
    const input = await jsonInput(c);
    if (input === undefined) return message(c, "Invalid JSON", 400);
    const name = input?.name;
    if (!isValidGitRepositoryName(name)) return message(c, "Invalid repository name", 400);
    const repository = await renameGitRepository(c.get("ownerId"), c.req.param("id"), name.trim(), origin(c));
    return repository ? c.json(repository) : c.text("Not found", 404);
  })
  .delete(REPOSITORY, async (c) =>
    await deleteGitRepository(c.env, c.get("ownerId"), c.req.param("id"))
      ? c.body(null, 204) : c.text("Not found", 404))
  .get(`${REPOSITORY}/thumbnail`, async (c) => {
    const headOnly = c.req.method === "HEAD";
    const thumbnail = await readGitRepositoryThumbnail(c.env, c.get("ownerId"), c.req.param("id"), { headOnly });
    if (!thumbnail) return c.text("Not found", 404);
    const headers = new Headers({
      ...THUMBNAIL_HEADERS,
      "Content-Length": String(thumbnail.size),
    });
    return new Response(headOnly ? null : thumbnail.body ?? null, { status: 200, headers });
  })
  .put(`${REPOSITORY}/thumbnail`, async (c) => {
    if (!isPngContentType(c.req.header("content-type"))) {
      return message(c, "Thumbnail must be a PNG image", 400);
    }
    const ownerId = c.get("ownerId");
    const repoId = c.req.param("id");
    if (!await ownsActiveGitRepository(ownerId, repoId)) {
      return c.text("Not found", 404);
    }
    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0) return message(c, "Invalid content length", 400);
      if (length > MAX_GIT_REPOSITORY_THUMBNAIL_BYTES) return message(c, "Thumbnail is too large", 413);
    }
    if (!c.req.raw.body) return message(c, "Thumbnail must be a PNG image", 400);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBytes(c.req.raw.body, MAX_GIT_REPOSITORY_THUMBNAIL_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyLimitExceededError) return message(c, "Thumbnail is too large", 413);
      throw error;
    }
    const result = await saveGitRepositoryThumbnail(c.env, ownerId, repoId, bytes, origin(c), {
      signal: c.req.raw.signal,
    });
    if (result.status === "notFound") return c.text("Not found", 404);
    if (result.status === "invalid") return message(c, "Thumbnail must be a valid PNG image", 400);
    return c.json(result.repository, 200);
  })
  .get(`${REPOSITORY}/tokens`, async (c) => {
    const tokens = await listGitAccessTokens(c.get("ownerId"), c.req.param("id"));
    return tokens ? c.json({ tokens }) : c.text("Not found", 404);
  })
  // The response carries the token secret; it cannot be read again later.
  .post(`${REPOSITORY}/tokens`, async (c) => {
    const input = await jsonInput(c);
    if (input === undefined) return message(c, "Invalid JSON", 400);
    const { name, scope } = input ?? {};
    if (!isValidGitAccessTokenName(name)) return message(c, "Invalid token name", 400);
    if (scope !== "read" && scope !== "write") return message(c, "Invalid Git scope", 400);
    const result = await createGitAccessToken(c.get("ownerId"), c.req.param("id"), name.trim(), scope);
    if (result.status === "notFound") return c.text("Not found", 404);
    if (result.status === "limitReached") return message(c, "Access token limit reached", 409);
    return c.json(result.token, 201);
  })
  .delete(`${REPOSITORY}/tokens/:tokenId{${UUID}}`, async (c) =>
    await revokeGitAccessToken(c.get("ownerId"), c.req.param("id"), c.req.param("tokenId"))
      ? c.body(null, 204) : c.text("Not found", 404));

export default repos;

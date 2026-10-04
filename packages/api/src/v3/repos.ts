import { Hono, type Context } from "hono";
import { isGitRepositoryId, isValidGitRepositoryName } from "@beutl/core";
import { getUserId } from "../api/auth";
import { gitPublicOrigin, type GitEnvironment } from "../git/environment";
import {
  createGitRepository,
  deleteGitRepository,
  findGitRepository,
  issueGitRepositoryToken,
  listGitRepositories,
  renameGitRepository,
} from "../git/repositories";
import { requireHostedGit } from "./git";

type Routes = { Bindings: GitEnvironment; Variables: { ownerId: string } };

const REPOSITORY = "/:id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}";

async function jsonInput(c: Context): Promise<Record<string, unknown> | null | undefined> {
  try { return await c.req.json(); } catch {
    // A body that is not JSON is the caller's input error, reported as 400.
    return undefined;
  }
}
const message = (c: Context, text: string, status: 400 | 401 | 409) => c.json({ message: text }, status);
const origin = (c: Context<Routes>) => gitPublicOrigin(c.env, c.req.url);

// Desktop clients manage repositories with their API JWT. Git traffic itself
// uses the repository-scoped tokens issued here (see ./git).
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
  .post(`${REPOSITORY}/token`, async (c) => {
    const input = await jsonInput(c);
    if (input === undefined) return message(c, "Invalid JSON", 400);
    const scope = input?.scope;
    if (scope !== "read" && scope !== "write") return message(c, "Invalid Git scope", 400);
    const token = await issueGitRepositoryToken(c.env, c.get("ownerId"), c.req.param("id"), scope);
    return token ? c.json(token) : c.text("Not found", 404);
  });

export default repos;

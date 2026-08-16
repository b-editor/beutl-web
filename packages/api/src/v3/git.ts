import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  ForgejoError,
  buildCloneUrl,
  createRepository,
  ensureGitAccount,
  getForgejoConfig,
  isForgejoConfigured,
  issueGitCredential,
  listRepositories,
} from "@beutl/forgejo";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";

/**
 * Beutl デスクトップの Git クライアント向けエンドポイント。
 *
 * 認証は v1 が発行する JWT (Authorization: Bearer) をそのまま使う。
 * git 本体の通信 (clone / fetch / push / LFS) はここを通らず、
 * Forgejo に直接 HTTPS で繋ぐ。ここが渡すのはその接続先と資格情報。
 */

const createSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  description: z.string().max(500).optional(),
});

async function requireUserId(c: Parameters<typeof getUserId>[0]) {
  return await getUserId(c);
}

const app = new Hono()
  .get("/account", async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    const account = await ensureGitAccount(userId);
    return c.json({
      username: account.forgejoUsername,
      baseUrl: getForgejoConfig().baseUrl,
    });
  })
  .post("/credentials", async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    // 発行するたびに以前のトークンは失効する。平文はこのレスポンスにしかない。
    const credential = await issueGitCredential(userId);
    return c.json({
      username: credential.username,
      // git の HTTPS Basic 認証でパスワードとして使う。
      password: credential.token,
    });
  })
  .get("/repositories", async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    const account = await ensureGitAccount(userId);
    const repositories = await listRepositories(account.forgejoUsername);
    return c.json(
      repositories.map((repository) => ({
        name: repository.name,
        description: repository.description,
        defaultBranch: repository.default_branch,
        empty: repository.empty,
        sizeBytes: repository.size * 1024,
        cloneUrl: repository.clone_url,
        updatedAt: repository.updated_at,
      })),
    );
  })
  .post("/repositories", zValidator("json", createSchema), async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    const { name, description } = c.req.valid("json");
    const account = await ensureGitAccount(userId);

    try {
      const repository = await createRepository(account.forgejoUsername, {
        name,
        description,
      });
      return c.json(
        {
          name: repository.name,
          description: repository.description,
          defaultBranch: repository.default_branch,
          cloneUrl: buildCloneUrl(account.forgejoUsername, repository.name),
        },
        201,
      );
    } catch (error) {
      if (error instanceof ForgejoError && error.isConflict) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 409,
        });
      }
      throw error;
    }
  });

export default app;

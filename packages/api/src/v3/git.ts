import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  CREDENTIAL_NAME_MAX_LENGTH,
  CredentialLimitReachedError,
  CredentialNameInvalidError,
  CredentialNameTakenError,
  ForgejoError,
  buildCloneUrl,
  createRepository,
  ensureGitAccount,
  getForgejoConfig,
  isForgejoConfigured,
  issueGitCredential,
  listGitCredentials,
  listRepositories,
  revokeGitCredential,
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

// 端末名は必須。省略できると、起動のたびに発行するクライアントがトークンを
// 際限なく積み上げてしまう。
const credentialSchema = z.object({
  deviceName: z.string().min(1).max(CREDENTIAL_NAME_MAX_LENGTH),
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
  .get("/credentials", async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    // 平文は含まない。どの端末に何を渡したかを見るためのもの。
    const credentials = await listGitCredentials(userId);
    return c.json(
      credentials.map((credential) => ({
        id: credential.id,
        deviceName: credential.name,
        lastEight: credential.lastEight,
        createdAt: credential.createdAt.toISOString(),
      })),
    );
  })
  .post("/credentials", zValidator("json", credentialSchema), async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    const { deviceName } = c.req.valid("json");
    try {
      // 端末ごとに 1 本。既存のトークンには触らないので、他の端末は使い続けられる。
      // 平文はこのレスポンスにしか現れない。
      const issued = await issueGitCredential(userId, deviceName);
      return c.json(
        {
          id: issued.credential.id,
          deviceName: issued.credential.name,
          username: issued.username,
          // git の HTTPS Basic 認証でパスワードとして使う。
          password: issued.token,
        },
        201,
      );
    } catch (error) {
      if (
        error instanceof CredentialNameTakenError ||
        error instanceof CredentialNameInvalidError
      ) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 409,
        });
      }
      if (error instanceof CredentialLimitReachedError) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 409,
        });
      }
      throw error;
    }
  })
  .delete("/credentials/:id", async (c) => {
    const userId = await requireUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    if (!isForgejoConfigured()) {
      return c.json(await apiErrorResponse("unknown"), { status: 503 });
    }

    // 指定した 1 本だけを失効させる。他の端末の資格情報は生きたまま。
    const revoked = await revokeGitCredential(userId, c.req.param("id"));
    if (!revoked) {
      return c.json(await apiErrorResponse("unknown"), { status: 404 });
    }
    return c.body(null, 204);
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

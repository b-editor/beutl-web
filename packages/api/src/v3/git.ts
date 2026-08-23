import { Hono } from "hono";
import type { Context } from "hono";
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
import { auditLogActions, GitRepositoryNameTakenError } from "@beutl/db";
import { addApiAuditLog } from "../api/audit";
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
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/),
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

/**
 * Forgejo ユーザーを用意する。初回はここで作られるので監査ログに残す。
 * 画面側の resolveGitUsername と同じ扱いにして、経路による差を作らない。
 */
async function ensureAccount(c: Context, userId: string) {
  const account = await ensureGitAccount(userId);
  if (account.created) {
    await addApiAuditLog(c, {
      userId,
      action: auditLogActions.git.accountProvisioned,
      details: account.forgejoUsername,
    });
  }
  return account;
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

    const account = await ensureAccount(c, userId);
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
    await ensureAccount(c, userId);
    try {
      // 端末ごとに 1 本。既存のトークンには触らないので、他の端末は使い続けられる。
      // 平文はこのレスポンスにしか現れない。
      const issued = await issueGitCredential(userId, deviceName);
      // 画面から発行したときと同じ粒度で残す。どの端末に資格情報を渡したかは、
      // 経路によらず追える必要がある。
      await addApiAuditLog(c, {
        userId,
        action: auditLogActions.git.issueCredential,
        details: issued.credential.name,
      });
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
    await addApiAuditLog(c, {
      userId,
      action: auditLogActions.git.revokeCredential,
      details: revoked.name,
    });
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

    const account = await ensureAccount(c, userId);
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
    const account = await ensureAccount(c, userId);

    try {
      const repository = await createRepository(account.forgejoUsername, {
        name,
        description,
      });
      await addApiAuditLog(c, {
        userId,
        action: auditLogActions.git.createRepository,
        details: `${account.forgejoUsername}/${repository.name}`,
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
      // 名前の衝突は 2 通り。Forgejo が返すものと、こちらの予約で弾いたもの
      // (同じ名前の作成が同時に来た場合)。どちらも利用者から見れば同じこと。
      if (
        (error instanceof ForgejoError && error.isConflict) ||
        error instanceof GitRepositoryNameTakenError
      ) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 409,
        });
      }
      throw error;
    }
  });

export default app;

import {
  createGitAccount,
  existsGitAccountUsername,
  findGitAccountByUserId,
  findProfileForApi,
} from "@beutl/db";
import { forgejoRequest, getForgejoConfig } from "./client";
import { ForgejoError } from "./errors";
import type { ForgejoAccessToken, ForgejoUser } from "./types";

/** デスクトップに渡す git 資格情報のトークン名。ユーザーごとに 1 本だけ持つ。 */
export const DESKTOP_TOKEN_NAME = "beutl-desktop";

const USERNAME_MAX_LENGTH = 30;
const USERNAME_FALLBACK = "beutl-user";
const MAX_USERNAME_ATTEMPTS = 20;

/**
 * Beutl の表示名を Forgejo が受け付けるユーザー名に寄せる。
 * Forgejo は英数字と `-` `_` `.` だけを許し、先頭と末尾に記号を置けない。
 */
export function normalizeUsername(source: string): string {
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, USERNAME_MAX_LENGTH)
    .replace(/[-._]+$/g, "");

  return normalized.length === 0 ? USERNAME_FALLBACK : normalized;
}

function candidateAt(base: string, attempt: number): string {
  if (attempt === 0) return base;
  const suffix = `-${attempt + 1}`;
  return `${base.slice(0, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Beutl アカウントに対応する Forgejo ユーザーを用意する。
 * 既にあればそれを返し、無ければ管理 API で作って対応表に記録する。
 */
export async function ensureGitAccount(userId: string): Promise<{
  forgejoUserId: number;
  forgejoUsername: string;
  created: boolean;
}> {
  const existing = await findGitAccountByUserId({ userId });
  if (existing) {
    return {
      forgejoUserId: existing.forgejoUserId,
      forgejoUsername: existing.forgejoUsername,
      created: false,
    };
  }

  const profile = await findProfileForApi({ where: { userId } });
  const base = normalizeUsername(profile?.userName ?? USERNAME_FALLBACK);
  const config = getForgejoConfig();
  const noreplyDomain = `users.noreply.${new URL(config.baseUrl).hostname}`;

  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
    const username = candidateAt(base, attempt);

    // 先に対応表を見て、明らかに埋まっている候補は Forgejo に投げない。
    if (await existsGitAccountUsername({ forgejoUsername: username })) {
      continue;
    }

    let created: ForgejoUser;
    try {
      created = await forgejoRequest<ForgejoUser>("/admin/users", {
        method: "POST",
        body: {
          username,
          // Forgejo はメールアドレスの一意性を要求する。Beutl 側の実アドレスは
          // 渡さず、到達しない専用ドメインで合成する。
          email: `${userId}@${noreplyDomain}`,
          password: randomSecret(),
          must_change_password: false,
          visibility: "private",
          restricted: false,
        },
      });
    } catch (error) {
      // ユーザー名が埋まっている / 予約語だった場合は次の候補へ。
      if (error instanceof ForgejoError && error.isConflict) {
        continue;
      }
      throw error;
    }

    try {
      await createGitAccount({
        userId,
        forgejoUserId: created.id,
        forgejoUsername: created.login,
      });
    } catch (error) {
      // 対応表に書けないと Forgejo 側が孤児になる。作ったものは畳んでから投げ直す。
      await forgejoRequest(`/admin/users/${created.login}`, {
        method: "DELETE",
        responseType: "none",
      }).catch(() => undefined);
      throw error;
    }

    return {
      forgejoUserId: created.id,
      forgejoUsername: created.login,
      created: true,
    };
  }

  throw new Error(
    `Could not find an available Forgejo username for user ${userId}`,
  );
}

/**
 * デスクトップが git のパスワードとして使うアクセストークンを発行する。
 *
 * Forgejo のトークン管理エンドポイントは Sudo 代理もトークン認証も受け付けず、
 * 対象ユーザー自身の Basic 認証だけを許す。ユーザーは Forgejo に対話ログインしないので、
 * 発行のたびに使い捨てのパスワードを管理 API で設定し、それで Basic 認証してから捨てる。
 * こうすると beutl-web 側に長期保存する資格情報が増えない。
 */
export async function issueGitCredential(userId: string): Promise<{
  username: string;
  token: string;
}> {
  const account = await ensureGitAccount(userId);
  const username = account.forgejoUsername;
  const password = randomSecret();

  // source_id と login_name を省くと 422 になる。
  await forgejoRequest(`/admin/users/${username}`, {
    method: "PATCH",
    body: { source_id: 0, login_name: username, password },
    responseType: "none",
  });

  const basicAuth = { username, password };
  const tokensPath = `/users/${username}/tokens`;

  const existing = await forgejoRequest<ForgejoAccessToken[]>(tokensPath, {
    basicAuth,
  });
  if (existing.some((token) => token.name === DESKTOP_TOKEN_NAME)) {
    await forgejoRequest(`${tokensPath}/${DESKTOP_TOKEN_NAME}`, {
      method: "DELETE",
      basicAuth,
      responseType: "none",
    });
  }

  const issued = await forgejoRequest<ForgejoAccessToken>(tokensPath, {
    method: "POST",
    basicAuth,
    body: {
      name: DESKTOP_TOKEN_NAME,
      scopes: ["write:repository"],
    },
  });

  if (!issued.sha1) {
    throw new Error("Forgejo did not return an access token");
  }

  return { username, token: issued.sha1 };
}

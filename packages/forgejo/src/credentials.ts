import {
  countGitCredentials,
  createGitCredential,
  deleteGitCredential,
  findGitCredential,
  findGitCredentialByName,
  listGitCredentialsByUserId,
} from "@beutl/db";
import { forgejoRequest } from "./client";
import { ForgejoError } from "./errors";
import { ensureGitAccount, randomSecret } from "./provisioning";
import type { ForgejoAccessToken } from "./types";

/**
 * 端末ラベルの上限。Forgejo のトークン名は 255 文字を超えると 500 を返すので、
 * その手前で、かつ一覧に並べて読める長さに絞る。
 */
export const CREDENTIAL_NAME_MAX_LENGTH = 50;

/** 1 ユーザーが持てる git トークンの本数。際限なく増えるのを防ぐ。 */
export const MAX_CREDENTIALS_PER_USER = 20;

export class CredentialNameInvalidError extends Error {
  constructor() {
    super("A git credential label must not be empty");
    this.name = "CredentialNameInvalidError";
  }
}

export class CredentialNameTakenError extends Error {
  constructor(readonly credentialName: string) {
    super(`A git credential named "${credentialName}" already exists`);
    this.name = "CredentialNameTakenError";
  }
}

export class CredentialLimitReachedError extends Error {
  constructor(readonly limit: number) {
    super(`A user may hold at most ${limit} git credentials`);
    this.name = "CredentialLimitReachedError";
  }
}

/**
 * ラベルを Forgejo のトークン名として使える形に整える。
 * Forgejo は空白も日本語もスラッシュも受け付けるので、制御文字を落として長さを絞るだけ。
 */
export function normalizeCredentialName(source: string): string {
  return source
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, CREDENTIAL_NAME_MAX_LENGTH)
    .trim();
}

export type IssuedCredential = {
  id: string;
  name: string;
  lastEight: string;
  createdAt: Date;
};

/**
 * トークン管理エンドポイント越しの操作をまとめる。
 *
 * Forgejo のトークン管理 (`/users/{username}/tokens`) は Sudo 代理もトークン認証も
 * 受け付けず、対象ユーザー自身の Basic 認証だけを許す。ユーザーは Forgejo に対話
 * ログインしないので、必要になるたび管理 API で使い捨てのパスワードを設定し、
 * それで Basic 認証してから捨てる。パスワードを変えても発行済みのトークンは失効しない。
 */
async function withTemporaryPassword<T>(
  username: string,
  fn: (basicAuth: { username: string; password: string }) => Promise<T>,
): Promise<T> {
  const password = randomSecret();

  // source_id と login_name を省くと 422 になる。
  await forgejoRequest(`/admin/users/${encodeURIComponent(username)}`, {
    method: "PATCH",
    body: { source_id: 0, login_name: username, password },
    responseType: "none",
  });

  return await fn({ username, password });
}

/**
 * git のパスワードとして使うアクセストークンを発行する。
 *
 * 端末ごとに 1 本持てる。既存のトークンには触らないので、ある端末で発行しても
 * 他の端末の資格情報が切れることはない。平文はこの戻り値にしか現れない。
 */
export async function issueGitCredential(
  userId: string,
  label: string,
): Promise<{
  username: string;
  token: string;
  credential: IssuedCredential;
}> {
  const name = normalizeCredentialName(label);
  if (name.length === 0) {
    throw new CredentialNameInvalidError();
  }

  const account = await ensureGitAccount(userId);
  const username = account.forgejoUsername;

  if ((await countGitCredentials({ userId })) >= MAX_CREDENTIALS_PER_USER) {
    throw new CredentialLimitReachedError(MAX_CREDENTIALS_PER_USER);
  }
  if (await findGitCredentialByName({ userId, name })) {
    throw new CredentialNameTakenError(name);
  }

  const issued = await withTemporaryPassword(username, async (basicAuth) => {
    try {
      return await forgejoRequest<ForgejoAccessToken>(
        `/users/${encodeURIComponent(username)}/tokens`,
        {
          method: "POST",
          basicAuth,
          body: { name, scopes: ["write:repository"] },
        },
      );
    } catch (error) {
      // 控えと Forgejo がずれていた場合もここに来る。名前の重複として同じ扱いにする。
      if (error instanceof ForgejoError && error.isConflict) {
        throw new CredentialNameTakenError(name);
      }
      throw error;
    }
  });

  if (!issued.sha1) {
    throw new Error("Forgejo did not return an access token");
  }

  const record = await createGitCredential({
    userId,
    name,
    forgejoTokenId: issued.id,
    lastEight: issued.sha1.slice(-8),
  });

  return {
    username,
    token: issued.sha1,
    credential: {
      id: record.id,
      name: record.name,
      lastEight: record.lastEight,
      createdAt: record.createdAt,
    },
  };
}

/**
 * 発行済みトークンの一覧。平文は含まない。
 *
 * Forgejo に問い合わせるとそのたびにパスワードの振り直しが要るので、表示用の
 * メタ情報はこちら側の控えから返す。Forgejo を触るのは発行と失効のときだけ。
 */
export async function listGitCredentials(
  userId: string,
): Promise<IssuedCredential[]> {
  const records = await listGitCredentialsByUserId({ userId });
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    lastEight: record.lastEight,
    createdAt: record.createdAt,
  }));
}

/**
 * トークンを 1 本失効させる。他のトークンには影響しない。
 *
 * 名前ではなく Forgejo 側の id で消す (名前には空白やスラッシュが入りうるため)。
 * Forgejo 側に既に無い場合も、控えを消して成功として扱う。
 */
export async function revokeGitCredential(
  userId: string,
  credentialId: string,
): Promise<IssuedCredential | null> {
  const record = await findGitCredential({ userId, id: credentialId });
  if (!record) return null;

  const account = await ensureGitAccount(userId);
  await withTemporaryPassword(account.forgejoUsername, async (basicAuth) => {
    try {
      await forgejoRequest(
        `/users/${encodeURIComponent(account.forgejoUsername)}/tokens/${record.forgejoTokenId}`,
        { method: "DELETE", basicAuth, responseType: "none" },
      );
    } catch (error) {
      if (error instanceof ForgejoError && error.isNotFound) return;
      throw error;
    }
  });

  await deleteGitCredential({ id: record.id });
  return {
    id: record.id,
    name: record.name,
    lastEight: record.lastEight,
    createdAt: record.createdAt,
  };
}

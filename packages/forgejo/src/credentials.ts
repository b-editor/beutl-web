import {
  countGitCredentials,
  createGitCredential,
  deleteGitCredential,
  findGitCredential,
  findGitCredentialByName,
  listGitCredentialsByUserId,
  startRetryableTransaction,
} from "@beutl/db";
import { forgejoRequest } from "./client";
import { ForgejoError } from "./errors";
import { ensureGitAccount } from "./provisioning";
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

/**
 * トークン名の重複かどうか。
 *
 * Forgejo 16.0.2 はこれを **400** で返す (実測: `access token name has been used
 * already`)。400 は他の入力エラーとも共通なので、状態だけでは判別できず本文を見る。
 * 409 と 422 も見るのは、他のエンドポイントに合わせた保険。
 */
function isTokenNameTaken(error: ForgejoError): boolean {
  if (error.isConflict) return true;
  return (
    error.status === 400 && error.body.includes("name has been used already")
  );
}

export type IssuedCredential = {
  id: string;
  name: string;
  lastEight: string;
  createdAt: Date;
};

/**
 * 管理トークンで対象ユーザーのトークンを操作するエンドポイント。
 *
 * `/users/{username}/tokens` の方は書き込みに対象ユーザー自身の Basic 認証を要求し、
 * 管理トークンでも Sudo 代理でも 401 (`auth method not allowed`) になる。
 * こちらの `/admin/users/{username}/tokens` は管理トークンで発行も失効もでき、
 * 発行時の応答に `sha1` も入る (Forgejo 16.0.2 で実測)。
 *
 * 以前はユーザーのパスワードを毎回振り直して Basic 認証していたが、それは
 * このエンドポイントを見落としていたため。パスワードを触らないので、同じユーザーの
 * 操作が同時に走っても互いの認証を壊さない。
 */
export function tokensPath(username: string, tokenId?: number): string {
  const base = `/admin/users/${encodeURIComponent(username)}/tokens`;
  return tokenId === undefined ? base : `${base}/${tokenId}`;
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

  // 早めに弾いて、捨てるだけのトークンを Forgejo に作らない。上限そのものは
  // 控えを書くトランザクションの中で見る (ここだけでは同時実行をすり抜ける)。
  if ((await countGitCredentials({ userId })) >= MAX_CREDENTIALS_PER_USER) {
    throw new CredentialLimitReachedError(MAX_CREDENTIALS_PER_USER);
  }
  if (await findGitCredentialByName({ userId, name })) {
    throw new CredentialNameTakenError(name);
  }

  let issued: ForgejoAccessToken;
  try {
    issued = await forgejoRequest<ForgejoAccessToken>(tokensPath(username), {
      method: "POST",
      body: { name, scopes: ["write:repository"] },
    });
  } catch (error) {
    // 控えと Forgejo がずれていた場合もここに来る。名前の重複として同じ扱いにする。
    if (error instanceof ForgejoError && isTokenNameTaken(error)) {
      throw new CredentialNameTakenError(name);
    }
    throw error;
  }

  // 平文は発行直後のこのレスポンスにしか入らない。取れなかったら黙って進めず落とす
  // (中途半端な控えを作ると、使えないトークンが一覧に残る)。発行自体は成功して
  // いるので、投げる前に Forgejo 側を畳む。放っておくと、誰にも使えず誰にも
  // 失効させられないトークンが残る。
  if (!issued.sha1) {
    await forgejoRequest(tokensPath(username, issued.id), {
      method: "DELETE",
      responseType: "none",
    }).catch((deleteError) => {
      console.error(
        `failed to drop the unusable token ${issued.id} for ${username}`,
        deleteError,
      );
    });
    throw new Error(
      `Forgejo returned no token for "${name}" (fields: ${Object.keys(issued).join(", ")})`,
    );
  }

  // クロージャの中では上の絞り込みが効かないので、ここで確定させておく。
  const lastEight = issued.token_last_eight ?? issued.sha1.slice(-8);

  let record;
  try {
    // 数えてから書くまでを 1 つのトランザクションに入れる。別々に行うと、19 本の
    // 状態で違う名前の発行が同時に走ったとき、両方が上限の検査を通って 21 本になる。
    record = await startRetryableTransaction(async (tx) => {
      if (
        (await countGitCredentials({ userId, prisma: tx })) >=
        MAX_CREDENTIALS_PER_USER
      ) {
        throw new CredentialLimitReachedError(MAX_CREDENTIALS_PER_USER);
      }
      return await createGitCredential({
        userId,
        name,
        forgejoTokenId: issued.id,
        // Forgejo が末尾 8 文字を返すならそれを使う。自前で切るのは返らない場合の保険。
        lastEight,
        prisma: tx,
      });
    });
  } catch (error) {
    // 控えを残せなかったので、Forgejo 側のトークンも消す。ここで諦めると、
    // 一覧にも出ず失効もできないトークンが生き続ける。消せなかった場合は、
    // 握り潰さずに記録を残す (元の例外は投げ直すので、ここでは投げない)。
    await forgejoRequest(tokensPath(username, issued.id), {
      method: "DELETE",
      responseType: "none",
    }).catch((deleteError) => {
      console.error(
        `failed to roll back the Forgejo token ${issued.id} for ${username}; ` +
          "it is not in our records, so nobody can revoke it from the UI",
        deleteError,
      );
    });

    // 上限に達していた場合は、名前の重複と取り違えさせない。
    if (error instanceof CredentialLimitReachedError) {
      throw error;
    }
    // 残るのは同じラベルの同時発行。Forgejo には 2 本できて、片方がここの
    // ユニーク制約で落ちる。
    throw new CredentialNameTakenError(name);
  }

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
 * 表示に必要なメタ情報はこちら側の控えに持っているので、Forgejo には問い合わせない。
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
  try {
    await forgejoRequest(
      tokensPath(account.forgejoUsername, record.forgejoTokenId),
      { method: "DELETE", responseType: "none" },
    );
  } catch (error) {
    // 既に無いなら目的は達している。それ以外は投げる (控えだけ消すと、生きた
    // トークンが誰にも失効できなくなる)。
    if (!(error instanceof ForgejoError && error.isNotFound)) throw error;
  }

  await deleteGitCredential({ id: record.id });
  return {
    id: record.id,
    name: record.name,
    lastEight: record.lastEight,
    createdAt: record.createdAt,
  };
}

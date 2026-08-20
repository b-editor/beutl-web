import { findGitAccountByUserId } from "@beutl/db";
import { forgejoRequest, forgejoRequestOrNull } from "./client";
import { tokensPath } from "./credentials";
import { ForgejoAccountMismatchError, ForgejoError } from "./errors";
import { noreplyEmailFor } from "./provisioning";
import type { ForgejoAccessToken, ForgejoUser } from "./types";

/**
 * Beutl アカウントの削除に伴う Forgejo 側の後始末。
 *
 * 端末に配った git トークンは Forgejo が直接認証する。git と LFS の通信は Caddy が
 * 素通しするので beutl-web を経由せず、こちらのレコードを消しても push は通り続ける。
 * トークンだけを無効化するフラグは無い (`active: false` も `prohibit_login: true` も
 * git のトークン認証を素通しする。Forgejo 16.0.2 で実測)。
 *
 * そこで 2 段階に分ける。
 *
 *   1. revokeGitAccess  — トークンを全て失効させる。ここが成否の分かれ目
 *   2. purgeGitAccount  — 消し漏れを掃き直してから、ユーザーとリポジトリを消す
 *
 * 1 が成功して 2 の前に落ちても、アクセスは既に断たれている。Beutl 側の削除を
 * 1 と 2 の間に置くのはそのため。先に purge してしまうと、後段の DB 更新が失敗した
 * ときに「アカウントは残っているのにリポジトリだけ消えた」という取り返しのつかない
 * 状態になる。
 */

/** トークン一覧の 1 ページあたりの件数。Forgejo の上限は 50。 */
const TOKEN_PAGE_SIZE = 50;

/** 一覧を読む上限ページ数。壊れた応答で無限に回らないための箍。 */
const MAX_TOKEN_PAGES = 40;

/**
 * 対応表が無くても Forgejo 上のユーザーを引き当てる。
 *
 * 対応表と Forgejo は別々にバックアップされるので、beutl-web の DB だけ古い時点に
 * 戻ると「対応表は無いが Forgejo にはユーザーが居る」状態になる。ここで諦めると、
 * 退会したのに端末のトークンが生き続ける。合成メールは userId から決まるので、
 * それで引く。
 *
 * 対応表がある場合も名前だけを信じない。**削除は取り返しがつかない**ので、
 * 通常操作と同じく id を照合し、さらにメールが本人のものであることまで確かめる。
 * 2 つの DB を別の時点に復元すると同じ名前が別人を指しうる。そのまま進めると、
 * 別人のトークンを全部失効させ、リポジトリごと消してしまう。
 */
async function resolveForgejoUser(userId: string): Promise<string | null> {
  const email = noreplyEmailFor(userId);
  const account = await findGitAccountByUserId({ userId });

  if (account) {
    const actual = await forgejoRequestOrNull<ForgejoUser>(
      `/users/${encodeURIComponent(account.forgejoUsername)}`,
    );
    if (!actual || actual.id !== account.forgejoUserId) {
      throw new ForgejoAccountMismatchError(
        account.forgejoUsername,
        account.forgejoUserId,
        actual?.id ?? null,
      );
    }
    // id が合っていてもメールが別人なら、対応表そのものが壊れている。
    if (actual.email !== email) {
      throw new ForgejoAccountMismatchError(
        account.forgejoUsername,
        account.forgejoUserId,
        actual.id,
      );
    }
    return account.forgejoUsername;
  }

  const found = await forgejoRequestOrNull<{ data?: ForgejoUser[] }>(
    "/users/search",
    { searchParams: { q: email, limit: 2 } },
  );
  const matches = (found?.data ?? []).filter((user) => user.email === email);
  if (matches.length !== 1) return null;
  return matches[0].login;
}

/** 端末に配ったトークンを全て失効させる。@returns 消した本数。 */
async function revokeAllTokens(username: string): Promise<number> {
  let revoked = 0;

  for (let page = 1; page <= MAX_TOKEN_PAGES; page++) {
    // page を指定しないと Forgejo は全件返すが、それは文書化された挙動ではない。
    // 明示的に読む。消しながら読むのでページ番号は進めない。
    const tokens = await forgejoRequest<ForgejoAccessToken[]>(
      tokensPath(username),
      { searchParams: { page: 1, limit: TOKEN_PAGE_SIZE } },
    );
    if (tokens.length === 0) return revoked;

    for (const token of tokens) {
      try {
        await forgejoRequest(tokensPath(username, token.id), {
          method: "DELETE",
          responseType: "none",
        });
        revoked += 1;
      } catch (error) {
        // 既に無いなら目的は達している。それ以外は投げて、退会自体を中止させる。
        if (!(error instanceof ForgejoError && error.isNotFound)) throw error;
      }
    }
  }

  throw new Error(
    `could not drain the access tokens of ${username} within ${MAX_TOKEN_PAGES} rounds`,
  );
}

/**
 * 端末に配ったトークンを全て失効させる。
 *
 * @returns 対象が居れば Forgejo 上のユーザー名、居なければ null。
 */
export async function revokeGitAccess(userId: string): Promise<string | null> {
  const username = await resolveForgejoUser(userId);
  if (!username) {
    // Git を一度も使っていないユーザー。Forgejo には何も無い。
    return null;
  }

  await revokeAllTokens(username);
  return username;
}

/**
 * ユーザーとそのリポジトリを消す。
 *
 * 消す前にトークンをもう一度掃く。失効から Beutl 側の削除までの間に発行された分が
 * ありうるためで、purge が失敗したときに生き残るのはまさにそれになる。
 *
 * purge 自体が失敗しても投げない。アクセスは断ててあるので穴は開かず、残るのは
 * 持ち主の居ないリポジトリだけ。呼び出し元は Beutl 側の削除を既に確定させていて、
 * ここで投げても戻せるものが無い。
 *
 * @returns 消し切れたかどうか。false なら Forgejo に手つかずのユーザーが残る。
 */
export async function purgeGitAccount(username: string): Promise<boolean> {
  try {
    await revokeAllTokens(username);
  } catch (error) {
    console.error(
      `failed to re-drain tokens for ${username} before purging`,
      error,
    );
  }

  try {
    await forgejoRequest(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      // リポジトリを持っているユーザーは purge を付けないと 422 で拒まれる。
      searchParams: { purge: true },
      responseType: "none",
    });
    return true;
  } catch (error) {
    if (error instanceof ForgejoError && error.isNotFound) return true;
    console.error(
      `failed to purge the Forgejo user ${username}; its repositories and LFS ` +
        "objects remain. No token can reach them, but nothing will retry this: " +
        "remove the user by hand (DELETE /api/v1/admin/users/" +
        `${username}?purge=true)`,
      error,
    );
    return false;
  }
}

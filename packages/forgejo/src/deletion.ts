import { findGitAccountByUserId } from "@beutl/db";
import { forgejoRequest, forgejoRequestOrNull } from "./client";
import { tokensPath } from "./credentials";
import { ForgejoError } from "./errors";
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
 *   2. purgeGitAccount  — ユーザーとリポジトリを消す。後片付け
 *
 * 1 が成功して 2 の前に落ちても、アクセスは既に断たれている。Beutl 側の削除を
 * 1 と 2 の間に置くのはそのため。先に purge してしまうと、後段の DB 更新が失敗した
 * ときに「アカウントは残っているのにリポジトリだけ消えた」という取り返しのつかない
 * 状態になる。
 */

/**
 * 対応表が無くても Forgejo 上のユーザーを引き当てる。
 *
 * 対応表と Forgejo は別々にバックアップされるので、beutl-web の DB だけ古い時点に
 * 戻ると「対応表は無いが Forgejo にはユーザーが居る」状態になる。ここで諦めると、
 * 退会したのに端末のトークンが生き続ける。合成メールは userId から決まるので、
 * それで引く。
 */
async function resolveForgejoUsername(userId: string): Promise<string | null> {
  const account = await findGitAccountByUserId({ userId });
  if (account) return account.forgejoUsername;

  const email = noreplyEmailFor(userId);
  const found = await forgejoRequestOrNull<{ data?: ForgejoUser[] }>(
    "/users/search",
    { searchParams: { q: email, limit: 2 } },
  );
  const matches = (found?.data ?? []).filter((user) => user.email === email);
  if (matches.length !== 1) return null;
  return matches[0].login;
}

/**
 * 端末に配ったトークンを全て失効させる。
 *
 * @returns 対象が居れば Forgejo 上のユーザー名、居なければ null。
 */
export async function revokeGitAccess(userId: string): Promise<string | null> {
  const username = await resolveForgejoUsername(userId);
  if (!username) {
    // Git を一度も使っていないユーザー。Forgejo には何も無い。
    return null;
  }

  const tokens = await forgejoRequest<ForgejoAccessToken[]>(
    tokensPath(username),
  );
  for (const token of tokens) {
    try {
      await forgejoRequest(tokensPath(username, token.id), {
        method: "DELETE",
        responseType: "none",
      });
    } catch (error) {
      // 既に無いなら目的は達している。それ以外は投げて、退会自体を中止させる。
      if (!(error instanceof ForgejoError && error.isNotFound)) throw error;
    }
  }

  return username;
}

/**
 * ユーザーとそのリポジトリを消す。
 *
 * アクセスは revokeGitAccess で既に断たれているので、ここが失敗しても穴は開かない。
 * 残るのは持ち主の居ないリポジトリだけなので、投げずに記録して次へ進む。
 */
export async function purgeGitAccount(username: string): Promise<void> {
  try {
    await forgejoRequest(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      // リポジトリを持っているユーザーは purge を付けないと 422 で拒まれる。
      searchParams: { purge: true },
      responseType: "none",
    });
  } catch (error) {
    if (error instanceof ForgejoError && error.isNotFound) return;
    console.error(
      `failed to purge the Forgejo user ${username}; its repositories are ` +
        "orphaned but no token can reach them any more",
      error,
    );
  }
}

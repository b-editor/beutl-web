import {
  createGitAccountDeletion,
  deleteGitAccountDeletion,
  findGitAccountByUserId,
  findGitAccountDeletion,
  listPendingGitAccountDeletions,
  recordGitAccountDeletionAttempt,
} from "@beutl/db";
import { forgejoRequest, forgejoRequestOrNull } from "./client";
import { tokensPath } from "./credentials";
import { ForgejoError } from "./errors";
import { assertMappingMatches, noreplyEmailFor } from "./provisioning";
import type { ForgejoAccessToken, ForgejoUser } from "./types";

/**
 * Beutl アカウントの削除に伴う Forgejo 側の後始末。
 *
 * 端末に配った git トークンは Forgejo が直接認証する。git と LFS の通信は Caddy が
 * 素通しするので beutl-web を経由せず、こちらのレコードを消しても push は通り続ける。
 * トークンだけを無効化するフラグは無い (`active: false` も `prohibit_login: true` も
 * git のトークン認証を素通しする。Forgejo 16.0.2 で実測)。
 *
 * 手順は次の通り。
 *
 *   1. beginGitAccountDeletion — 身元を確かめ、GitAccountDeletion を書く
 *   2. revokeGitAccess         — トークンを全て失効させる
 *   3. (呼び出し元) Beutl 側のレコードを削除する
 *   4. finishGitAccountDeletion — 掃き直して purge し、成功したら 1 の行を消す
 *
 * 1 の行が「まだ片付いていない」印になる。これがある間は資格情報を発行できない
 * (`assertGitAccountNotBeingDeleted`)。2 の後・4 の前に新しいトークンを作られると、
 * purge が失敗したときにそれだけが生き残るため。
 *
 * 4 が失敗しても 1 の行は残るので、`retryPendingGitDeletions` が拾って再試行できる。
 * ログや監査だけに頼らないのは、それらが失敗すると手掛かりが消えるため。
 */

/** トークン一覧の 1 ページあたりの件数。Forgejo の上限は 50。 */
const TOKEN_PAGE_SIZE = 50;

/** 一覧を読む上限ページ数。壊れた応答で無限に回らないための箍。 */
const MAX_TOKEN_PAGES = 40;

export class GitAccountBeingDeletedError extends Error {
  constructor(readonly userId: string) {
    super(`The Git account of ${userId} is being deleted`);
    this.name = "GitAccountBeingDeletedError";
  }
}

/**
 * 退会処理中なら投げる。資格情報の発行前に呼ぶ。
 *
 * これが無いと、トークンを失効させた後・Forgejo を消す前の隙間に発行が通り、
 * その 1 本だけが退会後も生き残る。
 */
export async function assertGitAccountNotBeingDeleted(userId: string) {
  if (await findGitAccountDeletion({ userId })) {
    throw new GitAccountBeingDeletedError(userId);
  }
}

/**
 * 対応表が無くても Forgejo 上のユーザーを引き当てる。
 *
 * 対応表と Forgejo は別々にバックアップされるので、beutl-web の DB だけ古い時点に
 * 戻ると「対応表は無いが Forgejo にはユーザーが居る」状態になる。ここで諦めると、
 * 退会したのに端末のトークンが生き続ける。合成メールは userId から決まるので、
 * それで引く。
 */
async function resolveForgejoUser(
  userId: string,
): Promise<{ username: string; id: number } | null> {
  const account = await findGitAccountByUserId({ userId });
  if (account) {
    // 削除は取り返しがつかない。名前・id・メールの 3 点が揃わなければ中止する。
    const actual = await assertMappingMatches(userId, account);
    return { username: account.forgejoUsername, id: actual.id };
  }

  const email = noreplyEmailFor(userId);
  const found = await forgejoRequestOrNull<{ data?: ForgejoUser[] }>(
    "/users/search",
    { searchParams: { q: email, limit: 2 } },
  );
  const matches = (found?.data ?? []).filter((user) => user.email === email);
  if (matches.length !== 1) return null;
  return { username: matches[0].login, id: matches[0].id };
}

/** 端末に配ったトークンを全て失効させる。@returns 消した本数。 */
async function revokeAllTokens(username: string): Promise<number> {
  let revoked = 0;

  for (let round = 1; round <= MAX_TOKEN_PAGES; round++) {
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
 * 退会処理を始める。身元を確かめ、片付け待ちの印を残す。
 *
 * @returns 対象が居れば Forgejo 上のユーザー名、居なければ null。
 */
export async function beginGitAccountDeletion(
  userId: string,
): Promise<string | null> {
  const target = await resolveForgejoUser(userId);
  if (!target) {
    // Git を一度も使っていないユーザー。Forgejo には何も無い。
    return null;
  }

  // 先に印を立てる。ここから資格情報の発行は拒まれる。
  await createGitAccountDeletion({
    userId,
    forgejoUsername: target.username,
    forgejoUserId: target.id,
  });

  await revokeAllTokens(target.username);
  return target.username;
}

/**
 * 掃き直してから Forgejo のユーザーとリポジトリを消す。成功したら印を消す。
 *
 * 掃き直すのは、失効から Beutl 側の削除までの間に発行された分がありうるため。
 * どちらかが失敗したら印を残したまま false を返す。呼び出し元は Beutl 側の削除を
 * 既に確定させていて、ここで投げても戻せるものが無い。
 *
 * @returns 消し切れたかどうか。false なら再試行の対象として残る。
 */
export async function finishGitAccountDeletion(
  userId: string,
  username: string,
): Promise<boolean> {
  try {
    await revokeAllTokens(username);

    await forgejoRequest(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      // リポジトリを持っているユーザーは purge を付けないと 422 で拒まれる。
      searchParams: { purge: true },
      responseType: "none",
    });
  } catch (error) {
    if (!(error instanceof ForgejoError && error.isNotFound)) {
      await recordGitAccountDeletionAttempt({
        userId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      console.error(
        `failed to finish deleting the Forgejo user ${username}; ` +
          "it stays queued in GitAccountDeletion for retry",
        error,
      );
      return false;
    }
  }

  await deleteGitAccountDeletion({ userId });
  return true;
}

/**
 * 片付け待ちの退会を拾って再試行する。
 *
 * 定期実行から呼ぶことを想定しているが、退会処理の入り口からも呼ぶ。前回落ちた分が
 * 次の退会のついでに片付く。
 *
 * @returns 片付いた件数と、まだ残っている件数。
 */
export async function retryPendingGitDeletions({
  limit = 20,
}: { limit?: number } = {}): Promise<{ finished: number; pending: number }> {
  const pending = await listPendingGitAccountDeletions({ limit });
  let finished = 0;

  for (const entry of pending) {
    if (await finishGitAccountDeletion(entry.userId, entry.forgejoUsername)) {
      finished += 1;
    }
  }

  return { finished, pending: pending.length - finished };
}

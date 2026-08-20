import {
  GitAccountDeletionPhase,
  deleteGitAccountDeletion,
  findGitAccountByUserId,
  findGitAccountDeletion,
  listPendingGitAccountDeletions,
  recordGitAccountDeletionAttempt,
  setGitAccountDeletionTarget,
  startGitAccountDeletion,
} from "@beutl/db";
import { forgejoRequest, forgejoRequestOrNull } from "./client";
import { tokensPath } from "./credentials";
import { ForgejoAccountMismatchError, ForgejoError } from "./errors";
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
 *   1. beginGitAccountDeletion  — 意思表示を書き、対象を確かめ、トークンを失効させる
 *   2. (呼び出し元) Beutl 側の削除と markGitAccountDeletionReady を同一トランザクションで
 *   3. finishGitAccountDeletion — 身元を確かめ直して purge し、成功したら印を消す
 *
 * 1 の行がある間は資格情報を発行できない。2 を同一トランザクションにするのは、
 * ローカルの削除が失敗したときに「まだ生きている利用者の purge 待ち」を作らないため。
 * 3 は毎回 id とメールを確かめ直す。待っている間に Forgejo が復元され、同じ名前が
 * 別人に渡っていることがある。
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
 * 退会処理中なら投げる。資格情報の発行の**前と後**に呼ぶ。
 *
 * 後にも呼ぶのは、前だけだと検査から発行までの間に退会が始まった場合に素通りする
 * ため。その 1 本は失効の走査に間に合わず、退会後も生き残る。
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
 * 退会処理を始める。意思表示を書き、身元を確かめ、トークンを失効させる。
 *
 * 対象が見つからなくても行は残す。**Git を使っていないように見えて、この直後に
 * 初回のプロビジョニングが走ることがある**ため。行があれば発行は止まるし、
 * 片付けの段になってもう一度探し直せる。
 */
export async function beginGitAccountDeletion(
  userId: string,
): Promise<string | null> {
  // 対象を探す前に書く。探している間に初めての Forgejo ユーザーを作られると、
  // 誰も片付けないまま端末のトークンだけが残る。
  await startGitAccountDeletion({ userId });

  const target = await resolveForgejoUser(userId);
  if (!target) return null;

  await setGitAccountDeletionTarget({
    userId,
    forgejoUsername: target.username,
    forgejoUserId: target.id,
  });
  await revokeAllTokens(target.username);
  return target.username;
}

/**
 * Forgejo のユーザーとリポジトリを消し、成功したら印を消す。
 *
 * 呼ぶ前に phase が READY_TO_PURGE であることを確かめる。BLOCKING のまま消すと、
 * ローカルの削除が失敗して生き残っている利用者のデータを落とすことになる。
 *
 * 対象は毎回探し直す。始めた時点では居なくても、その後に作られていることがある。
 * 見つかったら id とメールを確かめ直してから消す。待っている間に Forgejo が復元され、
 * 同じ名前が別人に渡っていることがあるため。
 *
 * @returns 消し切れたかどうか。false なら再試行の対象として残る。
 */
export async function finishGitAccountDeletion(
  userId: string,
): Promise<boolean> {
  const pending = await findGitAccountDeletion({ userId });
  if (!pending) return true;
  if (pending.phase !== GitAccountDeletionPhase.READY_TO_PURGE) {
    // まだ Beutl 側が消えていない。ここで消すと生きている利用者のデータを失う。
    return false;
  }

  try {
    let target: { username: string; id: number } | null;
    try {
      target = await resolveForgejoUser(userId);
    } catch (error) {
      if (error instanceof ForgejoAccountMismatchError) {
        // 名前は残っているが別人のもの。元のユーザーはもう居ないので、
        // 片付けとしては完了。**決して消しにいかない**。
        console.error(
          `not purging for ${userId}: the mapped name now belongs to someone else`,
          error,
        );
        await deleteGitAccountDeletion({ userId });
        return true;
      }
      throw error;
    }

    if (!target) {
      // 本当に何も無い。印を消して終わる。
      await deleteGitAccountDeletion({ userId });
      return true;
    }

    if (
      pending.forgejoUserId !== null &&
      pending.forgejoUserId !== target.id
    ) {
      // 名前は同じだが別人。Forgejo が復元されて id が振り直された場合など。
      // 元のユーザーはもう居ないので、片付けとしては完了。
      console.error(
        `not purging ${target.username}: it is now id ${target.id}, ` +
          `but the deletion queued id ${pending.forgejoUserId}`,
      );
      await deleteGitAccountDeletion({ userId });
      return true;
    }

    // 掃き直す。意思表示の前に始まっていた発行が着地していることがある。
    await revokeAllTokens(target.username);

    await forgejoRequest(
      `/admin/users/${encodeURIComponent(target.username)}`,
      {
        method: "DELETE",
        // リポジトリを持っているユーザーは purge を付けないと 422 で拒まれる。
        searchParams: { purge: true },
        responseType: "none",
      },
    );
  } catch (error) {
    if (!(error instanceof ForgejoError && error.isNotFound)) {
      await recordGitAccountDeletionAttempt({
        userId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      console.error(
        `failed to finish deleting the Forgejo account of ${userId}; ` +
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
 * 片付け待ちを拾って再試行する。定期実行から呼ぶ。
 *
 * @returns 片付いた件数と、まだ残っている件数。
 */
export async function retryPendingGitDeletions({
  limit = 20,
}: { limit?: number } = {}): Promise<{ finished: number; pending: number }> {
  const pending = await listPendingGitAccountDeletions({ limit });
  let finished = 0;

  for (const entry of pending) {
    if (await finishGitAccountDeletion(entry.userId)) {
      finished += 1;
    }
  }

  return { finished, pending: pending.length - finished };
}

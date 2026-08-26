import {
  currentGitRestoreGeneration,
  listGitCredentialRevocations,
  listGitRepositoryDeletions,
  markGitCredentialRevocationChecked,
  markGitRepositoryDeletionChecked,
  markGitRepositoryDeletionNeedsReview,
  pruneGitResurrectionTombstones,
  recordGitCredentialRevocationAttempt,
  recordGitRepositoryDeletionAttempt,
} from "@beutl/db";
import { forgejoRequest, forgejoRequestOrNull } from "./client";
import { tokensPath } from "./credentials";
import { ForgejoError } from "./errors";
import type { ForgejoAccessToken, ForgejoRepository } from "./types";

/**
 * 復元で生き返ったものを消し直す。
 *
 * 退会の墓標 (GitAccountDeletion) が見ているのは**アカウントごと消えた人**だけ。
 * 生きている利用者が 1 本だけ失効させたトークンと、消したリポジトリは、そちらには
 * 一切現れない。Forgejo をその操作より前へ戻すと、
 *
 *   - 端末に平文が残っている失効済みトークンが、また通るようになる
 *   - 消したリポジトリが、また見えるようになる
 *
 * のに、退会の 6 つの数はすべて 0 のままになる。**それでは証拠を出せない。**
 *
 * ここで見るのは「その相手が今も居るか」だけ。居れば消し直し、居なければこの世代で
 * 確認済みとして印を書く。
 */

/** 1 回で見る件数。多すぎると 1 回の cron が長引く。 */
const DEFAULT_LIMIT = 20;

/** 走査を繰り返す上限 (drain のとき)。暴走よけ。 */
const MAX_ROUNDS = 200;

/** トークン一覧の頁数の上限。credentials.ts と同じ根拠 (1 頁 50 件)。 */
const MAX_TOKEN_PAGES = 40;

/**
 * 控えを持ち続ける幅。
 *
 * **手元にあるバックアップで戻せる範囲より長くすること。** 短いと、まだ戻せる
 * 時点の控えを先に捨ててしまい、その復元で生き返ったものを誰も消し直せない。
 * git-server の既定は日次 14 世代なので、その倍に余裕を足してある。
 */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** そのユーザーの全トークンを読み切る。51 本目以降を取り逃さない。 */
async function listAllTokens(username: string): Promise<ForgejoAccessToken[]> {
  const all: ForgejoAccessToken[] = [];
  for (let page = 1; page <= MAX_TOKEN_PAGES; page++) {
    const batch = await forgejoRequestOrNull<ForgejoAccessToken[]>(
      tokensPath(username),
      { searchParams: { page: String(page), limit: "50" } },
    );
    // 利用者ごと消えている。生き返っているものは無い。
    if (batch === null) return all;
    all.push(...batch);
    if (batch.length < 50) return all;
  }
  throw new ForgejoError(
    500,
    "GET",
    tokensPath(username),
    `${username} has more tokens than ${MAX_TOKEN_PAGES} pages`,
  );
}

export async function reconcileGitResurrectionTombstones({
  limit = DEFAULT_LIMIT,
  /** 見るものが無くなるまで繰り返す。復元の直後に一巡させるため。 */
  drain = false,
}: { limit?: number; drain?: boolean } = {}): Promise<{
  checked: number;
  revoked: number;
  deleted: number;
  review: number;
  failed: number;
  pruned: number;
}> {
  const generation = await currentGitRestoreGeneration();
  let checked = 0;
  let revoked = 0;
  let deleted = 0;
  let review = 0;
  let failed = 0;

  for (let round = 1; round <= (drain ? MAX_ROUNDS : 1); round++) {
    const revocations = await listGitCredentialRevocations({
      generation,
      limit,
    });
    if (revocations.length === 0) break;
    let progressed = 0;

    // 同じ利用者の控えがまとまって並ぶので、一覧は 1 人 1 回で足りる。
    const tokensByUser = new Map<string, ForgejoAccessToken[] | null>();

    for (const entry of revocations) {
      try {
        if (!tokensByUser.has(entry.forgejoUsername)) {
          tokensByUser.set(
            entry.forgejoUsername,
            await listAllTokens(entry.forgejoUsername),
          );
        }
        const tokens = tokensByUser.get(entry.forgejoUsername) ?? [];
        const alive = tokens.find((token) => token.id === entry.forgejoTokenId);

        // **末尾 8 文字まで見る。** 復元で採番がやり直されると、同じ id を別の
        // トークンが持つことがある。id だけで消すと、その利用者が復元後に作った
        // 生きたトークンを消してしまう。
        if (alive && alive.token_last_eight === entry.lastEight) {
          await forgejoRequest(
            tokensPath(entry.forgejoUsername, entry.forgejoTokenId),
            { method: "DELETE", responseType: "none" },
          );
          // 一覧は控えてあるので、消した分をここからも外す。
          tokensByUser.set(
            entry.forgejoUsername,
            tokens.filter((token) => token.id !== entry.forgejoTokenId),
          );
          revoked += 1;
        }

        await markGitCredentialRevocationChecked({ id: entry.id, generation });
        checked += 1;
        progressed += 1;
      } catch (error) {
        await recordGitCredentialRevocationAttempt({
          id: entry.id,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        failed += 1;
      }
    }
    if (progressed === 0) break;
  }

  for (let round = 1; round <= (drain ? MAX_ROUNDS : 1); round++) {
    const deletions = await listGitRepositoryDeletions({ generation, limit });
    if (deletions.length === 0) break;
    let progressed = 0;

    for (const entry of deletions) {
      try {
        const current = await forgejoRequestOrNull<ForgejoRepository>(
          `/repositories/${entry.forgejoRepoId}`,
        );
        if (!current) {
          // 消えたまま。
          await markGitRepositoryDeletionChecked({
            forgejoRepoId: entry.forgejoRepoId,
            generation,
          });
          checked += 1;
          progressed += 1;
          continue;
        }

        // **その id が今も同じものを指しているか。** 復元で採番がやり直されると、
        // 同じ id を別のリポジトリが持ちうる。消す前に持ち主と名前で確かめる。
        // 食い違ったら消さない (消すのは取り返しがつかない)。
        if (
          current.owner.login.toLowerCase() !==
            entry.ownerUsername.toLowerCase() ||
          current.name !== entry.name
        ) {
          await markGitRepositoryDeletionNeedsReview({
            forgejoRepoId: entry.forgejoRepoId,
            reason:
              `id ${entry.forgejoRepoId} is now ` +
              `${current.owner.login}/${current.name}, recorded as ` +
              `${entry.ownerUsername}/${entry.name}`,
          });
          review += 1;
          progressed += 1;
          continue;
        }

        await forgejoRequest(
          `/repos/${encodeURIComponent(current.owner.login)}/${encodeURIComponent(current.name)}`,
          { method: "DELETE", responseType: "none" },
        );
        await markGitRepositoryDeletionChecked({
          forgejoRepoId: entry.forgejoRepoId,
          generation,
        });
        deleted += 1;
        checked += 1;
        progressed += 1;
      } catch (error) {
        await recordGitRepositoryDeletionAttempt({
          forgejoRepoId: entry.forgejoRepoId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        failed += 1;
      }
    }
    if (progressed === 0) break;
  }

  // 戻せる範囲より古い控えは、見張る相手がもう現れない。
  const { credentials, repositories } = await pruneGitResurrectionTombstones({
    before: new Date(Date.now() - TOMBSTONE_TTL_MS),
  });

  return {
    checked,
    revoked,
    deleted,
    review,
    failed,
    pruned: credentials + repositories,
  };
}

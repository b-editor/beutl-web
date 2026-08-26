import {
  confirmGitCredentialRevocation,
  confirmGitRepositoryDeletion,
  currentGitRestoreGeneration,
  deleteGitCredential,
  dropGitCredentialRevocation,
  dropGitRepositoryDeletion,
  listGitCredentialRevocations,
  listGitRepositoryDeletions,
  listUnconfirmedGitCredentialRevocations,
  listUnconfirmedGitRepositoryDeletions,
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
import { deleteResurrectedRepository } from "./repositories";
import type { ForgejoAccessToken } from "./types";

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
 * のに、退会の数はすべて 0 のままになる。**それでは証拠を出せない。**
 *
 * 控えには 2 つの段階がある。混ぜてはいけない。
 *
 *   確かめる前 (confirmed = false) — 消す**前**に書いた控え。消えたとは限らない。
 *     消えていれば確定させ、猶予を過ぎても残っていれば「行われなかった」として
 *     控えごと外す。**ここで消し直しにいってはいけない** (断られた削除を後から
 *     実行することになる)。
 *   確かめた後 (confirmed = true) — 消えたことを見ている。復元で戻っていれば
 *     消し直す。
 */

/** 1 回で見る件数。多すぎると 1 回の cron が長引く。 */
const DEFAULT_LIMIT = 20;

/** 走査を繰り返す上限 (drain のとき)。暴走よけ。 */
const MAX_ROUNDS = 200;

/** トークン一覧の頁数の上限。credentials.ts と同じ根拠 (1 頁 50 件)。 */
const MAX_TOKEN_PAGES = 40;

/**
 * 消したつもりのものが「まだ残っている」ことを、行われなかったと見なすまでの幅。
 *
 * 待つのをやめた後に Forgejo が確定させることがあるので、1 回見ただけでは決めない。
 * 予約の遅延着地に見ている幅と揃えてある。
 */
const UNCONFIRMED_GRACE_MS = 30 * 60 * 1000;

/**
 * 控えを持ち続ける幅。
 *
 * **手元にあるバックアップで戻せる範囲より長くすること。** 短いと、まだ戻せる
 * 時点の控えを先に捨ててしまい、その復元で生き返ったものを誰も消し直せない。
 * 既定は 90 日。バックアップの保持を延ばしたら `GIT_TOMBSTONE_TTL_DAYS` で
 * こちらも延ばす (off-host の控えを長く持つ運用ではとくに)。
 */
const DEFAULT_TOMBSTONE_TTL_DAYS = 90;

function tombstoneTtlMs(): number {
  const raw = process.env.GIT_TOMBSTONE_TTL_DAYS;
  const days = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
  if (raw !== undefined) {
    console.warn(
      `GIT_TOMBSTONE_TTL_DAYS=${raw} is not a positive number; ` +
        `keeping tombstones for ${DEFAULT_TOMBSTONE_TTL_DAYS} days`,
    );
  }
  return DEFAULT_TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

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

/**
 * 確かめる前の控えを決着させる。**消し直しはしない。**
 *
 * 消えていれば確定させる。残っていて猶予を過ぎていれば、行われなかったものとして
 * 控えごと外す。猶予の中なら何もしない (待つのをやめた後に Forgejo が確定させる
 * ことがある)。
 */
async function settleUnconfirmed(limit: number): Promise<{
  confirmed: number;
  dropped: number;
  repaired: number;
  failed: number;
}> {
  let confirmed = 0;
  let dropped = 0;
  let repaired = 0;
  let failed = 0;
  const staleBefore = Date.now() - UNCONFIRMED_GRACE_MS;

  for (const entry of await listUnconfirmedGitCredentialRevocations({
    limit,
  })) {
    try {
      const tokens = await listAllTokens(entry.forgejoUsername);
      const alive = tokens.find(
        (token) =>
          token.id === entry.forgejoTokenId &&
          token.token_last_eight === entry.lastEight,
      );
      if (!alive) {
        await confirmGitCredentialRevocation({ id: entry.id });
        confirmed += 1;
        // **Forgejo からは消えたのに、こちらの行が残っていることがある。**
        // 失効の途中で落ちた場合がこれ。放っておくと、使えないトークンが
        // 一覧と上限件数に残り続ける。ここで片付ける。
        if (entry.credentialId) {
          const removed = await deleteGitCredential({
            id: entry.credentialId,
          }).catch(() => null);
          if (removed) repaired += 1;
        }
        continue;
      }
      if (entry.revokedAt.getTime() < staleBefore) {
        // 生きたまま猶予を過ぎた = 失効は行われなかった。控えを外す。
        await dropGitCredentialRevocation({ id: entry.id });
        dropped += 1;
      }
    } catch (error) {
      await recordGitCredentialRevocationAttempt({
        id: entry.id,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      failed += 1;
    }
  }

  for (const entry of await listUnconfirmedGitRepositoryDeletions({ limit })) {
    try {
      const current = await forgejoRequestOrNull(
        `/repositories/${entry.forgejoRepoId}`,
      );
      if (!current) {
        await confirmGitRepositoryDeletion({
          forgejoRepoId: entry.forgejoRepoId,
        });
        confirmed += 1;
        continue;
      }
      if (entry.deletedAt.getTime() < staleBefore) {
        // 残ったまま猶予を過ぎた = 削除は行われなかった。**消し直さない。**
        // やり直すかどうかは利用者に委ねる。
        await dropGitRepositoryDeletion({ forgejoRepoId: entry.forgejoRepoId });
        dropped += 1;
      }
    } catch (error) {
      await recordGitRepositoryDeletionAttempt({
        forgejoRepoId: entry.forgejoRepoId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      failed += 1;
    }
  }

  return { confirmed, dropped, repaired, failed };
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
  confirmed: number;
  dropped: number;
  repaired: number;
}> {
  const generation = await currentGitRestoreGeneration();

  // 確かめる前の控えは、復元の有無によらず毎回決着させる。
  const settled = await settleUnconfirmed(limit);

  let checked = 0;
  let revoked = 0;
  let deleted = 0;
  let review = 0;
  let failed = settled.failed;

  // **一度も復元していないなら、消し直す相手は現れない。**
  //
  // 世代が無いまま回すと、確認の印 (checkedGeneration) に書く値も無く、同じ控えを
  // 何度も読み直すだけになる (書いた値が null なので、次の周回でもまた選ばれる)。
  if (generation !== null) {
    for (let round = 1; round <= (drain ? MAX_ROUNDS : 1); round++) {
      const revocations = await listGitCredentialRevocations({
        generation,
        limit,
      });
      if (revocations.length === 0) break;
      let progressed = 0;

      // 同じ利用者の控えがまとまって並ぶので、一覧は 1 人 1 回で足りる。
      const tokensByUser = new Map<string, ForgejoAccessToken[]>();

      for (const entry of revocations) {
        // **確かめたものだけを消しにいく。** 問い合わせ側でも絞っているが、
        // ここでも見る。断られた失効を後から実行するのは取り返しがつかない。
        if (!entry.confirmed) continue;
        try {
          if (!tokensByUser.has(entry.forgejoUsername)) {
            tokensByUser.set(
              entry.forgejoUsername,
              await listAllTokens(entry.forgejoUsername),
            );
          }
          const tokens = tokensByUser.get(entry.forgejoUsername) ?? [];
          const alive = tokens.find(
            (token) => token.id === entry.forgejoTokenId,
          );

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

          await markGitCredentialRevocationChecked({
            id: entry.id,
            generation,
          });
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
        // **確かめたものだけを消しにいく。** 確かめる前の控えを消し直しの対象に
        // すると、断られた削除を定期実行が実行し、利用者のリポジトリを消す。
        if (!entry.confirmed) continue;
        try {
          // 消すのは名前でしか送れない。名前を押さえ、押さえた後にもう一度 id を
          // 確かめてから送る (repositories.ts 側で行う)。
          const outcome = await deleteResurrectedRepository(entry);
          if (outcome === "moved") {
            await markGitRepositoryDeletionNeedsReview({
              forgejoRepoId: entry.forgejoRepoId,
              reason:
                `id ${entry.forgejoRepoId} no longer matches ` +
                `${entry.ownerUsername}/${entry.name}`,
            });
            review += 1;
            progressed += 1;
            continue;
          }
          if (outcome === "busy") {
            // その名前を今ほかの操作が動かしている。次の周回でやり直す。
            continue;
          }
          if (outcome === "deleted") deleted += 1;
          await markGitRepositoryDeletionChecked({
            forgejoRepoId: entry.forgejoRepoId,
            generation,
          });
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
  }

  // 戻せる範囲より古い控えは、見張る相手がもう現れない。
  const { credentials, repositories } = await pruneGitResurrectionTombstones({
    before: new Date(Date.now() - tombstoneTtlMs()),
  });

  return {
    checked,
    revoked,
    deleted,
    review,
    failed,
    pruned: credentials + repositories,
    confirmed: settled.confirmed,
    dropped: settled.dropped,
    repaired: settled.repaired,
  };
}
